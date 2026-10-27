import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  COMMAND_DEFINITION_ID,
  COMMAND_NAME,
  Config,
  MODE_EVENT_TYPE,
  MODE_PROJECTION_KEY,
  PROJECTION_KEY,
  SOURCE_KIND,
  apply,
  applyModeProjection,
  applyProjection,
  inject,
  modeStateSchema,
  modeViewSchema,
  name,
  parseMemoryCommand,
  projectionStateSchema,
} from '../src/index.js'
import { slugOf } from '../src/locate.js'
import { renderMemoryFile } from '../src/store.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-plugin-')))

let sessionCounter = 0

/** A real Session so `appendPluginRecord` can commit the mode record. */
async function newRealSession() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx.sessions.create(SessionId(`memory-command-${++sessionCounter}`))
}

/** The latest mode record the command appended to a real session. */
const lastModeEvent = (session) => session.snapshotEvents().filter((event) => event.type === MODE_EVENT_TYPE).at(-1)

/**
 * Mount the plugin against a recording context whose projection registry
 * folds committed events exactly as the host does, and return the pre-step
 * listener plus helpers that commit events to a fake session. Injection
 * tests mount with the switch on and the own store off, so "nothing entered"
 * keeps meaning "no Claude Code index"; the shipped defaults (switch off, own
 * store on) have their own tests. The own store's home always points into a
 * scratch directory so no test reads the developer's `~/.dsh/memory`.
 */
function mount(config = {}, { withCommands = false, commandError = undefined, withTools = true, expectDsh = undefined, sandboxMode = undefined, toolError = undefined } = {}) {
  const logs = []
  let listener
  const definitions = new Map()
  const states = new WeakMap()
  const commands = []
  const tools = []
  const toolEffects = []
  const ctx = {
    logger: { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) },
    on(event, handler) {
      assert.equal(event, 'agent/pre-step')
      listener = handler
      return () => {}
    },
    // Optional services the plugin asks for by name: the sandbox policy is the only one.
    get(name) {
      if (name === 'sandboxPolicy' && sandboxMode !== undefined) return { resolve: () => ({ mode: sandboxMode }) }
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('tools')) {
        if (withTools) {
          callback({
            // Cordis runs an effect's disposer when the scope unloads; `disposeTools` stands in for that.
            effect(execute) { toolEffects.push(execute()); return () => {} },
            tools: {
              register(definition) {
                if (toolError !== undefined && definition.name === toolError) throw new Error(`duplicate tool ${definition.name}`)
                tools.push(definition)
                return () => { tools.splice(tools.indexOf(definition), 1) }
              },
            },
          })
        }
        return
      }
      if (!withCommands || !deps.includes('commands')) return
      callback({
        commands: {
          register(definition) {
            if (commandError !== undefined) throw commandError
            commands.push(definition)
            return () => {}
          },
        },
      })
    },
    sessionProjections: {
      register(definition) {
        definitions.set(definition.key, definition)
        return () => {}
      },
      stateOf(session, key) {
        const definition = definitions.get(key)
        if (definition === undefined) return undefined
        let byKey = states.get(session)
        if (byKey === undefined) states.set(session, byKey = new Map())
        if (!byKey.has(key)) byKey.set(key, definition.init(session.header, 0))
        return byKey.get(key)
      },
    },
  }
  apply(ctx, Config({ readByDefault: { claude: true, dsh: true }, ownMemory: false, ownMemoryHome: scratch(), ...config }))
  const definition = definitions.get(PROJECTION_KEY)
  const modeDefinition = definitions.get(MODE_PROJECTION_KEY)
  assert.equal(definition.key, PROJECTION_KEY)
  assert.equal(definition.stateVersion, 2)
  assert.equal(modeDefinition.key, MODE_PROJECTION_KEY)
  assert.equal(modeDefinition.stateVersion, 3)
  assert.deepEqual(modeDefinition.init(), { read: {} })
  assert.deepEqual(
    modeDefinition.wire.view({ read: { claude: false, dsh: true } }),
    { sources: (expectDsh ?? config.ownMemory) ? [{ id: 'claude', enabled: false }, { id: 'dsh', enabled: true }] : [{ id: 'claude', enabled: false }] },
    'the dsh source exists only with an own store',
  )
  assert.deepEqual(modeDefinition.wire.viewSchema.parse({ sources: [{ id: 'dsh', enabled: false, extra: 1 }] }), { sources: [{ id: 'dsh', enabled: false }] })
  const commit = (session, event) => {
    for (const [key, unit] of definitions) {
      const prior = ctx.sessionProjections.stateOf(session, key)
      states.get(session).set(key, unit.apply(prior, event))
    }
  }
  const disposeTools = () => { for (const dispose of toolEffects.splice(0)) dispose() }
  return { listener, logs, commit, definition, modeDefinition, commands, tools, disposeTools, ctx }
}

const userMessage = (text) => ({ id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function fakeAgent({ cwd, origin }) {
  return { session: { id: 'session-test', header: { ...(cwd === undefined ? {} : { cwd }), ...(origin === undefined ? {} : { origin }) } } }
}

async function run(listener, { agent, step = 1, claimed = [userMessage('hi')], extra = [], batch }) {
  const decision = { kind: 'enter', messages: batch ?? [...claimed, ...extra] }
  return listener({ agent, messages: claimed, turn: 1, step, signal: new AbortController().signal }, async () => decision)
}

/** Commit every message of an entered decision as `user/message` events from `seq` on; returns the next free seq. */
function commitAll(commit, session, decision, seq) {
  let next = seq
  for (const message of decision.messages) {
    commit(session, { type: 'user/message', seq: next, time: next, surfaceOp: 'append', data: message })
    next += 1
  }
  return next
}

function seedProject(text = '- [Reply in Chinese](reply-in-chinese.md) — 用中文回复\n') {
  const home = scratch()
  const project = scratch()
  const dir = join(home, 'projects', slugOf(project), 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), text)
  return { home, project, path: join(dir, 'MEMORY.md') }
}

test('exports the plugin identity', () => {
  assert.equal(name, 'claude-memory')
  assert.deepEqual(inject, ['sessionProjections'])
  assert.equal(SOURCE_KIND, 'plugin:claude-memory')
  assert.equal(MODE_PROJECTION_KEY, 'claudeMemoryMode')
  assert.equal(COMMAND_NAME, 'memory')
})

test('Config applies Claude Code defaults and validates caps', () => {
  const resolved = Config({})
  assert.equal(resolved.maxLines, 200)
  assert.equal(resolved.maxChars, 25_000)
  assert.equal(resolved.includeSubagents, false)
  assert.deepEqual(resolved.readByDefault, { claude: false, dsh: true })
  assert.deepEqual(Config({ readByDefault: { claude: true } }).readByDefault, { claude: true, dsh: true })
  assert.equal(resolved.ownMemory, true)
  assert.ok(resolved.claudeHome.endsWith('/.claude'))
  assert.ok(resolved.ownMemoryHome.endsWith('/.dsh/memory'))
  assert.throws(() => Config({ maxLines: 0 }))
  assert.throws(() => Config({ maxChars: 1.5 }))
})

test('projection state schema accepts its own states and rejects others', () => {
  assert.deepEqual(projectionStateSchema.parse({ seq: null, digest: null, path: null }), { seq: null, digest: null, path: null })
  assert.deepEqual(projectionStateSchema.parse({ seq: 3, digest: 'd', path: '/p', extra: 1 }), { seq: 3, digest: 'd', path: '/p' })
  assert.throws(() => projectionStateSchema.parse({ seq: 'x', digest: null, path: null }))
  assert.throws(() => projectionStateSchema.parse(null))
})

test('projection fold records this plugin snapshots, ignores other events, and clears on a covering replace', () => {
  const empty = { seq: null, digest: null, path: null }
  const other = { type: 'user/message', seq: 1, surfaceOp: 'append', data: userMessage('x') }
  assert.equal(applyProjection(empty, other), empty)
  const mine = { type: 'user/message', seq: 2, surfaceOp: 'append', data: { source: { kind: SOURCE_KIND, form: 'snapshot', digest: 'abc', path: '/m' } } }
  const seen = applyProjection(empty, mine)
  assert.deepEqual(seen, { seq: 2, digest: 'abc', path: '/m' })
  assert.equal(applyProjection(seen, { type: 'turn/end', seq: 3, data: {} }), seen)
  const outside = { type: 'user/message', seq: 5, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, data: userMessage('c') }
  assert.equal(applyProjection(seen, outside), seen)
  const covering = { type: 'user/message', seq: 6, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 }, data: userMessage('c') }
  assert.deepEqual(applyProjection(seen, covering), empty, 'range decides when no source list is carried')
  const listed = { type: 'user/message', seq: 6, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 1 }, sourceEventSeqs: [3, 1, 2], data: userMessage('c') }
  assert.deepEqual(applyProjection(seen, listed), empty, 'the source list decides regardless of the numeric range')
  const unlisted = { type: 'user/message', seq: 6, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 }, sourceEventSeqs: [1, 3, 4, 5], data: userMessage('c') }
  assert.equal(applyProjection(seen, unlisted), seen, 'a replacement that does not name the snapshot leaves it visible')
  const notice = { type: 'user/message', seq: 7, surfaceOp: 'append', data: { source: { kind: SOURCE_KIND, form: 'notice', summary: 's' } } }
  assert.equal(applyProjection(seen, notice), seen)
})

test('mode state schema accepts on, off, and unset; the view schema only on and off', () => {
  assert.deepEqual(modeStateSchema.parse({ read: { claude: false, future: true }, extra: 1 }), { read: { claude: false, future: true } }, 'unknown source ids survive')
  assert.deepEqual(modeStateSchema.parse({ read: {} }), { read: {} })
  assert.throws(() => modeStateSchema.parse({ read: { claude: 'yes' } }))
  assert.throws(() => modeStateSchema.parse({ read: [] }))
  assert.throws(() => modeStateSchema.parse({ enabled: true }), 'the 0.4.0 shape is not accepted; the checkpoint is recomputed from the log')
  assert.throws(() => modeStateSchema.parse({}))
  assert.throws(() => modeStateSchema.parse(null))
  assert.deepEqual(modeViewSchema.parse({ sources: [] }), { sources: [] })
  assert.throws(() => modeViewSchema.parse({ sources: [{ id: 'claude', enabled: null }] }))
  assert.throws(() => modeViewSchema.parse({ enabled: true }))
})

test('the wire view resolves every unswitched source from readByDefault and lists dsh only with an own store', () => {
  const view = (config, state) => mount({ readByDefault: config, ownMemory: true }).modeDefinition.wire.view(state).sources
  assert.deepEqual(view({ claude: false, dsh: true }, { read: {} }), [{ id: 'claude', enabled: false }, { id: 'dsh', enabled: true }])
  assert.deepEqual(view({ claude: true, dsh: true }, { read: {} }), [{ id: 'claude', enabled: true }, { id: 'dsh', enabled: true }])
  assert.deepEqual(view({ claude: true, dsh: true }, { read: { dsh: false } }), [{ id: 'claude', enabled: true }, { id: 'dsh', enabled: false }])
  assert.deepEqual(mount({ ownMemory: false }).modeDefinition.wire.view({ read: { dsh: true } }).sources, [{ id: 'claude', enabled: true }])
})

test('ownMemory: false refuses the dsh source in /memory and reports only claude', async () => {
  const { commands } = mount({ ownMemory: false }, { withCommands: true })
  const session = await newRealSession()
  const agent = { session }
  assert.deepEqual(commands[0].handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Memory read: claude on' })
  assert.deepEqual(commands[0].handler({ agent, rawInput: 'dsh off' }), { kind: 'error', text: 'memory source dsh is not configured in this profile' })
  assert.deepEqual(commands[0].handler({ agent, rawInput: 'off' }).text, 'Memory read off: claude', 'a bare off touches only configured sources')
})

test('a relative ownMemoryHome turns the own store off with a warning instead of failing the mount', async () => {
  const { home, project } = seedProject()
  const { listener, logs, tools, modeDefinition } = mount({ claudeHome: home, ownMemory: true, ownMemoryHome: 'relative/memory' }, { expectDsh: false })
  assert.match(logs[0][1], /ownMemoryHome must be an absolute path/)
  assert.equal(tools.length, 0, 'no write tools without a store')
  assert.deepEqual(modeDefinition.wire.view({ read: {} }).sources.map((source) => source.id), ['claude'])
  const text = (await run(listener, { agent: fakeAgent({ cwd: project }) })).messages[1].content[0].text
  assert.ok(text.includes('- [Reply in Chinese](reply-in-chinese.md)'), 'the Claude Code index still enters')
  assert.ok(!text.includes('memory_save') && !text.includes('Your own memory'), 'without an own section')
})

test('a tool-name collision withdraws the tool that did register, so the framing says the store cannot be written', async () => {
  const ownHome = scratch()
  const project = scratch()
  const { listener, logs, tools } = mount({ claudeHome: scratch(), ownMemory: true, ownMemoryHome: ownHome }, { toolError: 'memory_delete' })
  assert.deepEqual(tools, [], 'memory_save was registered, then withdrawn')
  assert.match(logs[0][1], /cannot register the memory tools: duplicate tool memory_delete/)
  const text = (await run(listener, { agent: fakeAgent({ cwd: project }) })).messages[1].content[0].text
  assert.ok(text.includes('This host offers no memory tools'))
})

test('a read-only session is told the store cannot be written instead of being taught the tools', async () => {
  const { ownHome, project } = seedOwn()
  const { listener } = mount({ claudeHome: scratch(), ownMemory: true, ownMemoryHome: ownHome }, { sandboxMode: 'read-only' })
  const text = (await run(listener, { agent: fakeAgent({ cwd: project }) })).messages[1].content[0].text
  assert.ok(text.includes('This session is read-only under the file policy, so the store cannot be written from it.'))
  assert.ok(text.includes('- [Deploy host](deploy-host.md)'), 'the index still reads')
  assert.ok(!text.includes('memory_save'))
})

test('a blank window of an index that continues past it is not blank', async () => {
  const { home, project } = seedProject('\n\n- [real](real.md) — past the cap\n')
  const { listener, commit } = mount({ claudeHome: home, maxLines: 2 })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  assert.equal(first.messages.length, 2)
  const text = first.messages[1].content[0].text
  assert.ok(text.includes('Only the beginning of this index is shown'), 'shown as a truncated index, not withdrawn as blank')
  assert.ok(!text.includes('no longer available'))
  commitAll(commit, agent.session, first, 1)
  assert.equal((await run(listener, { agent })).messages.length, 1)
})

test('a host without a tool registry gets the own section without writing rules, and a warning once', async () => {
  const ownHome = scratch()
  const project = scratch()
  const { listener, logs, tools } = mount({ claudeHome: scratch(), ownMemory: true, ownMemoryHome: ownHome }, { withTools: false })
  assert.equal(tools.length, 0)
  const agent = fakeAgent({ cwd: project })
  const text = (await run(listener, { agent })).messages[1].content[0].text
  assert.ok(text.includes('This host offers no memory tools, so the store cannot be written from this session.'))
  assert.ok(!text.includes('memory_save'))
  await run(listener, { agent })
  assert.equal(logs.filter(([level, line]) => level === 'warn' && line.includes('no memory tools')).length, 1)
})

test('the write tools refuse subagents without includeSubagents and read-only sessions', async () => {
  const ownHome = scratch()
  const project = scratch()
  const withPolicy = mount({ ownMemory: true, ownMemoryHome: ownHome }, { sandboxMode: 'read-only' })
  const save = withPolicy.tools.find((tool) => tool.name === 'memory_save')
  const args = { name: 'x', type: 'user', title: 't', description: 'd', hook: 'h', content: 'c' }
  const exec = (header) => ({ name: 'memory_save', agent: { session: { id: 's', header } } })
  await assert.rejects(save.execute(args, exec({ cwd: project })), /read-only/)
  const open = mount({ ownMemory: true, ownMemoryHome: ownHome })
  const openSave = open.tools.find((tool) => tool.name === 'memory_save')
  await assert.rejects(openSave.execute(args, exec({ cwd: project, origin: 'subagent' })), /not available to subagents/)
  await assert.rejects(openSave.execute({ ...args, title: '  ' }, exec({ cwd: project })), /title must not be empty/)
  const saved = await openSave.execute(args, exec({ cwd: project }))
  assert.equal(saved.created, true)
  const shared = mount({ ownMemory: true, ownMemoryHome: scratch(), includeSubagents: true })
  const sharedSave = shared.tools.find((tool) => tool.name === 'memory_save')
  assert.equal((await sharedSave.execute(args, exec({ cwd: project, origin: 'subagent' }))).created, true)
})

test('an own store that cannot be inspected enters nothing this turn, even when the Claude Code index could', async () => {
  const { ownHome, project } = seedOwn()
  const { home } = seedProject()
  const claudeDir = join(home, 'projects', slugOf(project), 'memory')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, 'MEMORY.md'), '- claude line\n')
  const { listener, commit, logs } = mount({ claudeHome: home, ownMemory: true, ownMemoryHome: ownHome, readByDefault: { claude: true, dsh: true } })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  assert.equal(first.messages.length, 2)
  assert.ok(first.messages[1].content[0].text.includes('- claude line'))
  commitAll(commit, agent.session, first, 1)
  writeFileSync(join(claudeDir, 'MEMORY.md'), '- claude line changed\n')
  utimesSync(join(claudeDir, 'MEMORY.md'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  // Only the own store's directory becomes uninspectable; the Claude Code index stays readable and has changed.
  const { chmodSync, statSync } = await import('node:fs')
  const ownDir = join(ownHome, slugOf(project))
  chmodSync(ownDir, 0o000)
  let inspectable = true
  try { statSync(join(ownDir, 'MEMORY.md')) } catch { inspectable = false }
  try {
    if (!inspectable) {
      const next = await run(listener, { agent })
      assert.equal(next.messages.length, 1, 'a changed Claude index would enter a message without the own section: nothing entered, no withdrawal')
      assert.ok(logs.some(([level, line]) => level === 'warn' && line.includes('cannot inspect the own memory index')))
    }
  } finally {
    chmodSync(ownDir, 0o755)
  }
})

test('unloading the tool scope makes the next message say the store cannot be written', async () => {
  const { ownHome, project } = seedOwn()
  const { listener, tools, disposeTools, commit } = mount({ claudeHome: scratch(), ownMemory: true, ownMemoryHome: ownHome })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  assert.ok(first.messages[1].content[0].text.includes('memory_save'))
  commitAll(commit, agent.session, first, 1)
  assert.equal(tools.length, 2)
  disposeTools()
  const after = await run(listener, { agent })
  assert.equal(after.messages.length, 2, 'the framing changed, so a new snapshot enters')
  assert.ok(after.messages[1].content[0].text.includes('This host offers no memory tools'))
  assert.ok(!after.messages[1].content[0].text.includes('memory_save'))
})

test('parses the /memory argument grammar', () => {
  assert.deepEqual(parseMemoryCommand(''), { action: 'status' })
  assert.deepEqual(parseMemoryCommand('  '), { action: 'status' })
  assert.deepEqual(parseMemoryCommand('status'), { action: 'status' })
  assert.deepEqual(parseMemoryCommand(' off '), { action: 'set', sources: ['claude', 'dsh'], enabled: false })
  assert.deepEqual(parseMemoryCommand('ON'), { action: 'set', sources: ['claude', 'dsh'], enabled: true })
  assert.deepEqual(parseMemoryCommand('dsh off'), { action: 'set', sources: ['dsh'], enabled: false })
  assert.deepEqual(parseMemoryCommand('Claude  ON'), { action: 'set', sources: ['claude'], enabled: true })
  assert.equal(parseMemoryCommand('bogus'), undefined)
  assert.equal(parseMemoryCommand('bogus on'), undefined)
  assert.equal(parseMemoryCommand('off always'), undefined)
  assert.equal(parseMemoryCommand('dsh claude on'), undefined)
})

test('mode projection folds switch events per source, reads 0.4.0 records as claude, and ignores surface replacements', () => {
  const unset = { read: {} }
  assert.equal(applyModeProjection(unset, { type: 'command/run', data: { name: COMMAND_NAME, args: 'off' } }), unset)
  const legacy = applyModeProjection(unset, { type: MODE_EVENT_TYPE, data: { enabled: false } })
  assert.deepEqual(legacy, { read: { claude: false } })
  const dshOff = applyModeProjection(legacy, { type: MODE_EVENT_TYPE, data: { source: 'dsh', enabled: false } })
  assert.deepEqual(dshOff, { read: { claude: false, dsh: false } })
  assert.equal(applyModeProjection(dshOff, { type: MODE_EVENT_TYPE, data: { source: 'dsh', enabled: false } }), dshOff)
  assert.equal(applyModeProjection(dshOff, { type: MODE_EVENT_TYPE, data: {} }), dshOff)
  assert.equal(applyModeProjection(dshOff, { type: MODE_EVENT_TYPE, data: { source: 7, enabled: true } }), dshOff)
  assert.deepEqual(applyModeProjection(dshOff, { type: MODE_EVENT_TYPE, data: { source: 'future', enabled: true } }), { read: { claude: false, dsh: false, future: true } })
  assert.equal(applyModeProjection(dshOff, { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 9 }, data: userMessage('x') }), dshOff)
})

test('registers /memory only when a command surface is composed', () => {
  const without = mount()
  assert.equal(without.commands.length, 0)
  const withCommands = mount({}, { withCommands: true })
  assert.equal(withCommands.commands.length, 1)
  const command = withCommands.commands[0]
  assert.equal(command.name, COMMAND_NAME)
  assert.equal(command.definitionId, COMMAND_DEFINITION_ID)
  assert.equal(command.input.hint, '[claude|dsh] on|off | status')
})

test('a command registration failure is logged and leaves injection working', async () => {
  const { home, project } = seedProject()
  const { listener, logs } = mount(
    { claudeHome: home },
    { withCommands: true, commandError: new Error('duplicate command name') },
  )
  assert.deepEqual(logs.map(([level]) => level), ['warn'])
  assert.match(logs[0][1], /cannot register \/memory: duplicate command name/)
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: project }) })).messages.length, 2)
})

/** Commit every mode record the command appended to a real session (folding is idempotent). */
const commitModeEvents = (commit, session) => {
  for (const event of session.snapshotEvents()) if (event.type === MODE_EVENT_TYPE) commit(session, event)
}

test('the /memory command appends one switch per changed source and reports state', async () => {
  const { commands, commit, ctx } = mount({ ownMemory: true }, { withCommands: true })
  const command = commands[0]
  const session = await newRealSession()
  const agent = { session }
  assert.deepEqual(ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY), { read: {} })
  assert.deepEqual(command.handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Memory read: claude on, dsh on' })
  const off = command.handler({ agent, rawInput: 'off' })
  assert.equal(off.kind, 'success')
  assert.equal(off.text, 'Memory read off: claude, dsh')
  assert.ok(Number.isInteger(off.sourceEventSeq))
  assert.deepEqual(session.snapshotEvents().filter((event) => event.type === MODE_EVENT_TYPE).map((event) => event.data), [{ source: 'claude', enabled: false }, { source: 'dsh', enabled: false }])
  commitModeEvents(commit, session)
  assert.deepEqual(ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY), { read: { claude: false, dsh: false } })
  assert.deepEqual(command.handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Memory read: claude off, dsh off' })
  assert.deepEqual(command.handler({ agent, rawInput: 'off' }), { kind: 'success', text: 'Memory read already off: claude off, dsh off' })
  assert.deepEqual(command.handler({ agent, rawInput: 'dsh off' }), { kind: 'success', text: 'Memory read already off: dsh off' })
  const dshOn = command.handler({ agent, rawInput: 'dsh on' })
  assert.equal(dshOn.kind, 'success')
  assert.equal(dshOn.text, 'Memory read on: dsh')
  assert.ok(Number.isInteger(dshOn.sourceEventSeq))
  commitModeEvents(commit, session)
  assert.deepEqual(ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY), { read: { claude: false, dsh: true } })
  assert.equal(command.handler({ agent, rawInput: 'on' }).text, 'Memory read on: claude', 'a bare on switches only the sources still off')
  assert.deepEqual(command.handler({ agent, rawInput: 'bogus' }), { kind: 'error', text: 'usage: /memory [claude|dsh] on|off | status' })
})

test('on the shipped default only dsh is read until /memory claude on, and "already" appends nothing', async () => {
  const { commands, commit, ctx } = mount({ ownMemory: true, readByDefault: { claude: false, dsh: true } }, { withCommands: true })
  const command = commands[0]
  const session = await newRealSession()
  const agent = { session }
  assert.deepEqual(command.handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Memory read: claude off, dsh on' })
  assert.deepEqual(command.handler({ agent, rawInput: 'claude off' }), { kind: 'success', text: 'Memory read already off: claude off' })
  assert.equal(lastModeEvent(session), undefined)
  assert.equal(command.handler({ agent, rawInput: 'claude on' }).kind, 'success')
  commitModeEvents(commit, session)
  assert.deepEqual(ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY), { read: { claude: true } })
  assert.deepEqual(command.handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Memory read: claude on, dsh on' })
})

test('a throwing switch append leaves the mode unchanged and reports an error', () => {
  const { commands, logs, ctx } = mount({}, { withCommands: true })
  const command = commands[0]
  const session = { id: 'session-test', header: {} }
  const result = command.handler({ agent: { session }, rawInput: 'off' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /session log rejected/)
  assert.deepEqual(ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY), { read: {} })
  assert.match(logs.at(-1)[1], /cannot store the memory switch/)
})

test('the real projection service restores the switch from the committed log', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  apply(ctx, Config({}))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const session = ctx.sessions.create(SessionId(`memory-real-${++sessionCounter}`))
  const agent = { id: session.id, session }
  assert.deepEqual(ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY), { read: {} })
  const execution = await ctx.commands.execute(agent, '/memory on', [], new AbortController().signal)
  assert.ok(execution)
  assert.equal(execution.result.kind, 'success')
  assert.ok(Number.isInteger(execution.result.sourceEventSeq))
  assert.deepEqual(ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY), { read: { claude: true } }, 'dsh already reads by default, so only claude is switched')
  assert.ok(session.snapshotEvents().some((event) => event.type === MODE_EVENT_TYPE && event.ignorable === true))
  const restored = ctx.sessions.create(SessionId(`memory-real-${++sessionCounter}`), { seed: session.snapshotEvents() })
  assert.deepEqual(ctx.sessionProjections.stateOf(restored, MODE_PROJECTION_KEY), { read: { claude: true } })
})

test('on the shipped default a session enters no Claude Code index until /memory claude on', async () => {
  const { home, project } = seedProject()
  const { listener, commit } = mount({ claudeHome: home, readByDefault: { claude: false, dsh: true } })
  const agent = fakeAgent({ cwd: project })
  assert.equal((await run(listener, { agent })).messages.length, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 1, data: { enabled: true } })
  assert.equal((await run(listener, { agent })).messages.length, 2)
})

test('enters the index right after the claimed batch, with a sourced snapshot', async () => {
  const { home, project, path } = seedProject()
  const { listener, logs } = mount({ claudeHome: home })
  const runtime = userMessage('runtime')
  const decision = await run(listener, { agent: fakeAgent({ cwd: project }), extra: [runtime] })
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 3)
  const entered = decision.messages[1]
  assert.equal(entered.role, 'user')
  assert.equal(entered.source.kind, SOURCE_KIND)
  assert.equal(entered.source.form, 'snapshot')
  assert.equal(entered.source.path, path)
  assert.match(entered.source.digest, /^[0-9a-f]{64}$/)
  assert.ok(entered.content[0].text.includes('- [Reply in Chinese](reply-in-chinese.md) — 用中文回复'))
  assert.ok(entered.content[0].text.includes(`Contents of ${path}`))
  assert.equal(decision.messages[2], runtime)
  assert.deepEqual(logs.map(([level]) => level), ['info'])
})

test('appends at the tail when the claimed messages were replaced by copies', async () => {
  const { home, project } = seedProject()
  const { listener } = mount({ claudeHome: home })
  const claimed = [userMessage('hi')]
  const decision = await run(listener, { agent: fakeAgent({ cwd: project }), claimed, batch: [structuredClone(claimed[0])] })
  assert.deepEqual(decision.messages.map((message) => message.source.kind), ['user', SOURCE_KIND])
})

test('does not enter the index twice while the visible snapshot is current, re-enters after a change or a covering replace', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, commit } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  assert.equal(first.messages.length, 2)
  commitAll(commit, agent.session, first, 1)
  assert.equal((await run(listener, { agent })).messages.length, 1, 'same digest visible: nothing entered')
  writeFileSync(path, '- one\n- two\n')
  utimesSync(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  const changed = await run(listener, { agent })
  assert.equal(changed.messages.length, 2)
  assert.notEqual(changed.messages[1].source.digest, first.messages[1].source.digest)
  commitAll(commit, agent.session, changed, 10)
  assert.equal((await run(listener, { agent })).messages.length, 1)
  commit(agent.session, { type: 'user/message', seq: 20, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 19 }, data: userMessage('compacted') })
  const after = await run(listener, { agent })
  assert.equal(after.messages.length, 2, 'snapshot shadowed by compaction is entered again')
  assert.equal(after.messages[1].source.digest, changed.messages[1].source.digest)
})

test('turning the switch off suppresses injection and refresh until it is turned back on', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, commit } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  assert.equal(first.messages.length, 2)
  commitAll(commit, agent.session, first, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 10, data: { enabled: false } })
  assert.equal((await run(listener, { agent })).messages.length, 1, 'off: no injection')
  writeFileSync(path, '- two\n')
  utimesSync(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  assert.equal((await run(listener, { agent })).messages.length, 1, 'off: no refresh')
  commit(agent.session, { type: 'user/message', seq: 11, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 10 }, data: userMessage('compacted') })
  assert.equal((await run(listener, { agent })).messages.length, 1, 'off survives a covering replace')
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 12, data: { enabled: true } })
  const on = await run(listener, { agent })
  assert.equal(on.messages.length, 2)
  assert.ok(on.messages[1].content[0].text.includes('- two'))
})

test('turning the switch off before the first turn enters nothing', async () => {
  const { home, project } = seedProject()
  const { listener, commit } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 1, data: { enabled: false } })
  assert.equal((await run(listener, { agent })).messages.length, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 2, data: { enabled: true } })
  assert.equal((await run(listener, { agent })).messages.length, 2)
})

test('re-enabling with an unchanged index does not re-enter it', async () => {
  const { home, project } = seedProject('- one\n')
  const { listener, commit } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  commitAll(commit, agent.session, first, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 10, data: { enabled: false } })
  assert.equal((await run(listener, { agent })).messages.length, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 11, data: { enabled: true } })
  assert.equal((await run(listener, { agent })).messages.length, 1, 'the shown index is still current')
})

test('re-enabling after the index disappears withdraws it', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, commit } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  commitAll(commit, agent.session, first, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 10, data: { enabled: false } })
  rmSync(path)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 11, data: { enabled: true } })
  const on = await run(listener, { agent })
  assert.equal(on.messages.length, 2)
  assert.ok(on.messages[1].content[0].text.includes('no longer available'))
})

test('a switch that lands after the initial check suppresses the injection', async () => {
  const { home, project } = seedProject()
  const { listener, ctx } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const original = ctx.sessionProjections.stateOf
  let modeReads = 0
  ctx.sessionProjections.stateOf = (session, key) => {
    if (key === MODE_PROJECTION_KEY) {
      modeReads += 1
      if (modeReads === 2) return { read: { claude: false } }
    }
    return original(session, key)
  }
  assert.equal((await run(listener, { agent })).messages.length, 1)
})

test('a snapshot already in the batch is not duplicated', async () => {
  const { home, project } = seedProject()
  const { listener } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  const again = await run(listener, { agent, extra: [first.messages[1]] })
  assert.equal(again.messages.length, 2)
})

test('withdraws a shown index once the file disappears or becomes blank, exactly once', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, commit } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  commitAll(commit, agent.session, first, 1)
  rmSync(path)
  const gone = await run(listener, { agent })
  assert.equal(gone.messages.length, 2)
  assert.ok(gone.messages[1].content[0].text.includes(`(${path}) is no longer available`))
  assert.equal(gone.messages[1].source.path, path)
  commitAll(commit, agent.session, gone, 10)
  assert.equal((await run(listener, { agent })).messages.length, 1, 'withdrawal is itself deduplicated')
  writeFileSync(path, '- back\n')
  const back = await run(listener, { agent })
  assert.equal(back.messages.length, 2)
  assert.ok(back.messages[1].content[0].text.includes('- back'))
  commitAll(commit, agent.session, back, 20)
  writeFileSync(path, '\n\n')
  utimesSync(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  const blank = await run(listener, { agent })
  assert.equal(blank.messages.length, 2)
  assert.ok(blank.messages[1].content[0].text.includes('no longer available'))
})

test('never withdraws when nothing was shown', async () => {
  const { home } = seedProject()
  const { listener } = mount({ claudeHome: home })
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: scratch() }) })).messages.length, 1)
})

test('stays out of rejected, later, empty, subagent, cwd-less, and memoryless steps', async () => {
  const { home, project } = seedProject()
  const { listener } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const reject = await listener({ agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
  assert.deepEqual(reject, { kind: 'reject' })
  assert.equal((await run(listener, { agent, step: 2 })).messages.length, 1)
  assert.equal((await run(listener, { agent, claimed: [] })).messages.length, 0)
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: project, origin: 'subagent' }) })).messages.length, 1)
  assert.equal((await run(listener, { agent: fakeAgent({}) })).messages.length, 1, 'no recorded cwd: nothing, never the process directory')
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: scratch() }) })).messages.length, 1)
  const { listener: withSubagents } = mount({ claudeHome: home, includeSubagents: true })
  assert.equal((await run(withSubagents, { agent: fakeAgent({ cwd: project, origin: 'subagent' }) })).messages.length, 2)
})

test('reuses the rendered index while size and mtime hold, and re-reads when they change', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const fixed = 1_700_000_000 // seconds; applied before and after the rewrite so mtimeMs compares equal
  utimesSync(path, fixed, fixed)
  const first = await run(listener, { agent })
  writeFileSync(path, '- two\n') // same size
  utimesSync(path, fixed, fixed) // same mtime
  const stale = await run(listener, { agent })
  assert.equal(stale.messages[1].source.digest, first.messages[1].source.digest, 'stat unchanged in size and mtime: cached render')
  writeFileSync(path, '- three!\n') // different size
  const fresh = await run(listener, { agent })
  assert.ok(fresh.messages[1].content[0].text.includes('- three!'))
})

test('a read failure after the index was shown never withdraws it, and the next successful read is cached fresh', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, logs, commit } = mount({ claudeHome: home })
  const { chmodSync, readFileSync } = await import('node:fs')
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  commitAll(commit, agent.session, first, 1)
  utimesSync(path, 1_700_000_000, 1_700_000_000) // invalidate the rendered cache
  chmodSync(path, 0o000)
  let readable = true
  try { readFileSync(path) } catch { readable = false }
  try {
    if (!readable) {
      const during = await run(listener, { agent })
      assert.equal(during.messages.length, 1, 'read error: no withdrawal, no re-entry')
      assert.deepEqual(logs.map(([level]) => level), ['info', 'warn'])
    }
  } finally {
    chmodSync(path, 0o644)
  }
  assert.equal((await run(listener, { agent })).messages.length, 1, 'same content readable again: still deduplicated')
  writeFileSync(path, '- changed\n')
  assert.ok((await run(listener, { agent })).messages[1].content[0].text.includes('- changed'))
})

test('an uninspectable memory directory after the index was shown never withdraws it', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, logs, commit } = mount({ claudeHome: home })
  const { chmodSync, statSync } = await import('node:fs')
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  commitAll(commit, agent.session, first, 1)
  const dir = join(path, '..')
  chmodSync(dir, 0o000)
  let inspectable = true
  try { statSync(path) } catch { inspectable = false }
  try {
    if (!inspectable) {
      assert.equal((await run(listener, { agent })).messages.length, 1)
      assert.equal(logs.at(-1)[0], 'warn')
    }
  } finally {
    chmodSync(dir, 0o755)
  }
})

test('warns once per session for an unreadable index', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, logs } = mount({ claudeHome: home })
  const { chmodSync } = await import('node:fs')
  chmodSync(path, 0o000)
  try {
    const { readFileSync } = await import('node:fs')
    let readable = true
    try { readFileSync(path) } catch { readable = false }
    if (readable) return // running as root: permission bits do not apply
    const agent = fakeAgent({ cwd: project })
    assert.equal((await run(listener, { agent })).messages.length, 1)
    assert.equal((await run(listener, { agent })).messages.length, 1)
    assert.deepEqual(logs.map(([level]) => level), ['warn'])
  } finally {
    chmodSync(path, 0o644)
  }
})

test('expands ~ in claudeHome', async () => {
  const { listener } = mount({ claudeHome: '~/.claude-does-not-exist-for-this-test' })
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: scratch() }) })).messages.length, 1)
})

/** Write one own-store entry file the way the save tool does; the index is projected from it. */
function seedEntry(dir, name, title, hook) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), renderMemoryFile({ name, description: hook, title, hook, type: 'project', content: 'body', sessionId: 's', modified: new Date(0) }))
}

/** A project whose own store already holds entries (one by default); the Claude Code home stays empty. */
function seedOwn(entries = [['deploy-host', 'Deploy host', '部署机是 mini']]) {
  const ownHome = scratch()
  const project = scratch()
  const dir = join(ownHome, slugOf(project))
  mkdirSync(dir, { recursive: true })
  for (const [name, title, hook] of entries) seedEntry(dir, name, title, hook)
  return { ownHome, project, ownPath: join(dir, 'MEMORY.md') }
}

test('with the own store on, a project without any memory still gets the directory and the writing rules', async () => {
  const ownHome = scratch()
  const project = scratch()
  const { listener, logs } = mount({ claudeHome: scratch(), ownMemory: true, ownMemoryHome: ownHome })
  const decision = await run(listener, { agent: fakeAgent({ cwd: project }) })
  assert.equal(decision.messages.length, 2)
  const text = decision.messages[1].content[0].text
  assert.equal(decision.messages[1].source.path, join(ownHome, slugOf(project), 'MEMORY.md'))
  assert.ok(text.includes(`lives in ${join(ownHome, slugOf(project))}. It has no entries yet`))
  assert.ok(text.includes('Save a memory with the `memory_save` tool'))
  assert.ok(!text.includes("Claude Code's memory index"))
  assert.deepEqual(logs.map(([level]) => level), ['info'])
})

test('with the own store on, both indexes enter as one snapshot keyed by the Claude Code path', async () => {
  const { home, project, path } = seedProject('- [Reply in Chinese](reply-in-chinese.md) — 用中文回复\n')
  const ownHome = scratch()
  seedEntry(join(ownHome, slugOf(project)), 'deploy-host', 'Deploy host', '部署机是 mini')
  const ownPath = join(ownHome, slugOf(project), 'MEMORY.md')
  const { listener } = mount({ claudeHome: home, ownMemory: true, ownMemoryHome: ownHome })
  const decision = await run(listener, { agent: fakeAgent({ cwd: project }) })
  assert.equal(decision.messages.length, 2)
  const text = decision.messages[1].content[0].text
  assert.equal(decision.messages[1].source.path, path)
  assert.ok(text.includes(`Contents of ${path}`))
  assert.ok(text.includes('- [Reply in Chinese](reply-in-chinese.md)'))
  assert.ok(text.includes(`Contents of ${ownPath}`))
  assert.ok(text.includes('- [Deploy host](deploy-host.md)'))
})

test('a memory the model writes is entered on the next turn, and a vanished Claude Code index drops its section without a withdrawal', async () => {
  const { home, project, path } = seedProject('- one\n')
  const ownHome = scratch()
  const { listener, commit } = mount({ claudeHome: home, ownMemory: true, ownMemoryHome: ownHome })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  assert.ok(first.messages[1].content[0].text.includes('It has no entries yet'))
  commitAll(commit, agent.session, first, 1)
  assert.equal((await run(listener, { agent })).messages.length, 1, 'unchanged: nothing entered')
  const dir = join(ownHome, slugOf(project))
  seedEntry(dir, 'deploy-host', 'Deploy host', '部署机是 mini')
  const written = await run(listener, { agent })
  assert.equal(written.messages.length, 2)
  assert.ok(written.messages[1].content[0].text.includes('- [Deploy host](deploy-host.md)'))
  assert.ok(!written.messages[1].content[0].text.includes('no entries yet'))
  commitAll(commit, agent.session, written, 10)
  rmSync(path)
  const gone = await run(listener, { agent })
  assert.equal(gone.messages.length, 2)
  const text = gone.messages[1].content[0].text
  assert.ok(!text.includes('no longer available'), 'the own section still stands, so the message is a replacement, not a withdrawal')
  assert.ok(!text.includes("Claude Code's memory index"))
  assert.ok(text.includes('- [Deploy host](deploy-host.md)'))
  assert.equal(gone.messages[1].source.path, join(dir, 'MEMORY.md'))
})

test('an own store without entries reads as no entries yet; an unreadable index file degrades to "not loaded" and keeps the Claude Code section', async () => {
  const { ownHome, project, ownPath } = seedOwn([])
  writeFileSync(ownPath, '\n\n')
  const { home } = seedProject('- claude line\n')
  // The Claude index lives under a different project root; point this project's slug at it.
  const claudeDir = join(home, 'projects', slugOf(project), 'memory')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, 'MEMORY.md'), '- claude line\n')
  const { listener, logs } = mount({ claudeHome: home, ownMemory: true, ownMemoryHome: ownHome, readByDefault: { claude: true, dsh: true } })
  const agent = fakeAgent({ cwd: project })
  assert.ok((await run(listener, { agent })).messages[1].content[0].text.includes('It has no entries yet'))
  const { chmodSync, readFileSync } = await import('node:fs')
  seedEntry(join(ownHome, slugOf(project)), 'a', 'a', 'b')
  chmodSync(ownPath, 0o000)
  let readable = true
  try { readFileSync(ownPath) } catch { readable = false }
  try {
    if (!readable) {
      const degraded = await run(listener, { agent })
      assert.equal(degraded.messages.length, 2)
      const text = degraded.messages[1].content[0].text
      assert.ok(text.includes('- claude line'), 'the Claude Code section still enters')
      assert.ok(text.includes('is not loaded in this session'), 'the own section says the index is not loaded')
      assert.ok(!text.includes('- [a](a.md)'))
      assert.ok(logs.some(([level, line]) => level === 'warn' && line.includes(ownPath)), 'the unreadable index is warned about')
    }
  } finally {
    chmodSync(ownPath, 0o644)
  }
})

test('the own store is shared by every worktree of a repository', async () => {
  const main = scratch()
  mkdirSync(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
  writeFileSync(join(main, '.git', 'worktrees', 'feat', 'commondir'), '../..\n')
  const wt = join(main, '.claude', 'worktrees', 'feat')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  const ownHome = scratch()
  const { listener } = mount({ claudeHome: scratch(), ownMemory: true, ownMemoryHome: ownHome })
  const fromWorktree = await run(listener, { agent: fakeAgent({ cwd: wt }) })
  const fromMain = await run(listener, { agent: { session: { id: 'session-main', header: { cwd: main } } } })
  assert.equal(fromWorktree.messages[1].source.path, join(ownHome, slugOf(main), 'MEMORY.md'))
  assert.equal(fromWorktree.messages[1].source.digest, fromMain.messages[1].source.digest)
})

test('with dsh read off the own store is still announced for writing, its index unread', async () => {
  const { ownHome, project, ownPath } = seedOwn()
  const { listener, commit } = mount({ claudeHome: scratch(), ownMemory: true, ownMemoryHome: ownHome, readByDefault: { claude: false, dsh: false } })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  assert.equal(first.messages.length, 2, 'every source off, yet the write rules enter')
  const text = first.messages[1].content[0].text
  assert.ok(text.includes(`Its index ${ownPath} is not loaded in this session; \`cat\` it before saving`))
  assert.ok(!text.includes('- [Deploy host](deploy-host.md)'), 'the index content is not read')
  assert.ok(text.includes('Save a memory with the `memory_save` tool'))
  commitAll(commit, agent.session, first, 1)
  assert.equal((await run(listener, { agent })).messages.length, 1, 'the static section is entered once')
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 10, data: { source: 'dsh', enabled: true } })
  const on = await run(listener, { agent })
  assert.equal(on.messages.length, 2)
  assert.ok(on.messages[1].content[0].text.includes('- [Deploy host](deploy-host.md)'))
})

test('with every source off and no own store, a turn enters nothing', async () => {
  const { home, project } = seedProject()
  const { listener } = mount({ claudeHome: home, readByDefault: { claude: false, dsh: false } })
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: project }) })).messages.length, 1)
})

test('switching claude off mid-session drops its section from the next message instead of withdrawing', async () => {
  const { home, project } = seedProject('- one\n')
  const ownHome = scratch()
  const { listener, commit } = mount({ claudeHome: home, ownMemory: true, ownMemoryHome: ownHome })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  assert.ok(first.messages[1].content[0].text.includes('- one'))
  commitAll(commit, agent.session, first, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 10, data: { source: 'claude', enabled: false } })
  const next = await run(listener, { agent })
  assert.equal(next.messages.length, 2)
  assert.ok(!next.messages[1].content[0].text.includes('- one'))
  assert.ok(!next.messages[1].content[0].text.includes('no longer available'))
})

test('ownMemory: false keeps the Claude Code index alone, and ~ expands in ownMemoryHome', async () => {
  const { home, project } = seedProject()
  const off = await run(mount({ claudeHome: home }).listener, { agent: fakeAgent({ cwd: project }) })
  assert.ok(!off.messages[1].content[0].text.includes('Save a memory'))
  const { listener } = mount({ claudeHome: home, ownMemory: true, ownMemoryHome: '~/.dsh-memory-does-not-exist-for-this-test' })
  const expanded = await run(listener, { agent: fakeAgent({ cwd: project }) })
  assert.ok(expanded.messages[1].content[0].text.includes(join(process.env.HOME, '.dsh-memory-does-not-exist-for-this-test')))
})
