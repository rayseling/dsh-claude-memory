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
 * tests mount with the switch on; the shipped default (off) has its own tests.
 */
async function mount(config = {}, { withCommands = false, commandError = undefined } = {}) {
  const logs = []
  let listener
  const definitions = new Map()
  const states = new WeakMap()
  const commands = []
  const ctx = {
    logger: { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) },
    on(event, handler) {
      assert.equal(event, 'agent/pre-step')
      listener = handler
      return () => {}
    },
    inject(deps, callback) {
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
      async register(definition) {
        definitions.set(definition.key, definition)
        return { stateOf: (session) => projections.read(session, definition.key) }
      },
      stateOf() {
        throw new Error('the plugin must read through its registration handles')
      },
    },
  }
  /** Keyed state as the host folds it; tests read and intercept through `read`. */
  const projections = {
    read(session, key) {
      const definition = definitions.get(key)
      let byKey = states.get(session)
      if (byKey === undefined) states.set(session, byKey = new Map())
      if (!byKey.has(key)) byKey.set(key, definition.init(session.header, 0))
      return byKey.get(key)
    },
  }
  await apply(ctx, Config({ enabledByDefault: true, ...config }))
  const definition = definitions.get(PROJECTION_KEY)
  const modeDefinition = definitions.get(MODE_PROJECTION_KEY)
  assert.equal(definition.key, PROJECTION_KEY)
  assert.equal(definition.stateVersion, 2)
  assert.equal(modeDefinition.key, MODE_PROJECTION_KEY)
  assert.equal(modeDefinition.stateVersion, 2)
  assert.deepEqual(modeDefinition.init(), { enabled: null })
  assert.deepEqual(modeDefinition.wire.view({ enabled: false }), { enabled: false })
  assert.deepEqual(modeDefinition.wire.viewSchema.parse({ enabled: false }), { enabled: false })
  const commit = (session, event) => {
    for (const [key, unit] of definitions) {
      const prior = projections.read(session, key)
      states.get(session).set(key, unit.apply(prior, event))
    }
  }
  return { listener, logs, commit, definition, modeDefinition, commands, projections }
}

const userMessage = (text) => ({ id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function fakeAgent({ cwd, origin }) {
  return { session: { id: 'session-test', header: { ...(cwd === undefined ? {} : { cwd }), ...(origin === undefined ? {} : { origin }) } } }
}

async function run(listener, { agent, step = 1, claimed = [userMessage('hi')], extra = [], batch }) {
  const decision = { kind: 'enter', messages: batch ?? [...claimed, ...extra] }
  return listener({ agent, messages: claimed, turn: 1, step, signal: new AbortController().signal }, async () => decision)
}

/** Commit every message of an entered decision as `user/message` events from `seq` on. */
function commitAll(commit, session, decision, seq) {
  let next = seq
  for (const message of decision.messages) commit(session, { type: 'user/message', seq: next, time: next, surfaceOp: 'append', data: message })
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
  assert.equal(resolved.enabledByDefault, false)
  assert.ok(resolved.claudeHome.endsWith('/.claude'))
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
  assert.deepEqual(modeStateSchema.parse({ enabled: false, extra: 1 }), { enabled: false })
  assert.deepEqual(modeStateSchema.parse({ enabled: true }), { enabled: true })
  assert.deepEqual(modeStateSchema.parse({ enabled: null }), { enabled: null })
  assert.throws(() => modeStateSchema.parse({ enabled: 'yes' }))
  assert.throws(() => modeStateSchema.parse({}))
  assert.throws(() => modeStateSchema.parse(null))
  assert.deepEqual(modeViewSchema.parse({ enabled: true }), { enabled: true })
  assert.throws(() => modeViewSchema.parse({ enabled: null }))
})

test('the wire view resolves an unset switch from enabledByDefault', async () => {
  assert.deepEqual((await mount({ enabledByDefault: false })).modeDefinition.wire.view({ enabled: null }), { enabled: false })
  assert.deepEqual((await mount({ enabledByDefault: true })).modeDefinition.wire.view({ enabled: null }), { enabled: true })
  assert.deepEqual((await mount({ enabledByDefault: true })).modeDefinition.wire.view({ enabled: false }), { enabled: false })
})

test('parses the /memory argument grammar', () => {
  assert.equal(parseMemoryCommand(''), 'status')
  assert.equal(parseMemoryCommand('  '), 'status')
  assert.equal(parseMemoryCommand(' off '), 'off')
  assert.equal(parseMemoryCommand('ON'), 'on')
  assert.equal(parseMemoryCommand('status'), 'status')
  assert.equal(parseMemoryCommand('bogus'), undefined)
  assert.equal(parseMemoryCommand('off always'), undefined)
})

test('mode projection folds only switch events and ignores surface replacements', () => {
  const unset = { enabled: null }
  assert.equal(applyModeProjection(unset, { type: 'command/run', data: { name: COMMAND_NAME, args: 'off' } }), unset)
  const off = applyModeProjection(unset, { type: MODE_EVENT_TYPE, data: { enabled: false } })
  assert.deepEqual(off, { enabled: false })
  assert.equal(applyModeProjection(off, { type: MODE_EVENT_TYPE, data: { enabled: false } }), off)
  assert.equal(applyModeProjection(off, { type: MODE_EVENT_TYPE, data: {} }), off)
  assert.equal(applyModeProjection(off, { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 9 }, data: userMessage('x') }), off)
})

test('registers /memory only when a command surface is composed', async () => {
  const without = await mount()
  assert.equal(without.commands.length, 0)
  const withCommands = await mount({}, { withCommands: true })
  assert.equal(withCommands.commands.length, 1)
  const command = withCommands.commands[0]
  assert.equal(command.name, COMMAND_NAME)
  assert.equal(command.definitionId, COMMAND_DEFINITION_ID)
  assert.equal(command.input.hint, 'on|off|status')
})

test('a command registration failure is logged and leaves injection working', async () => {
  const { home, project } = seedProject()
  const { listener, logs } = await mount(
    { claudeHome: home },
    { withCommands: true, commandError: new Error('duplicate command name') },
  )
  assert.deepEqual(logs.map(([level]) => level), ['warn'])
  assert.match(logs[0][1], /cannot register \/memory: duplicate command name/)
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: project }) })).messages.length, 2)
})

test('the /memory command appends the switch and reports state', async () => {
  const { commands, commit, projections } = await mount({}, { withCommands: true })
  const command = commands[0]
  const session = await newRealSession()
  const agent = { session }
  assert.deepEqual(projections.read(session, MODE_PROJECTION_KEY), { enabled: null })
  assert.deepEqual(command.handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Claude Code memory is on' })
  const off = command.handler({ agent, rawInput: 'off' })
  assert.equal(off.kind, 'success')
  assert.equal(off.text, 'Claude Code memory off')
  assert.ok(Number.isInteger(off.sourceEventSeq))
  commit(session, lastModeEvent(session))
  assert.deepEqual(projections.read(session, MODE_PROJECTION_KEY), { enabled: false })
  assert.deepEqual(command.handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Claude Code memory is off' })
  assert.deepEqual(command.handler({ agent, rawInput: 'off' }), { kind: 'success', text: 'Claude Code memory is already off' })
  const on = command.handler({ agent, rawInput: 'on' })
  assert.equal(on.kind, 'success')
  assert.equal(on.text, 'Claude Code memory on')
  assert.ok(Number.isInteger(on.sourceEventSeq))
  commit(session, lastModeEvent(session))
  assert.deepEqual(projections.read(session, MODE_PROJECTION_KEY), { enabled: true })
  assert.deepEqual(command.handler({ agent, rawInput: 'bogus' }), { kind: 'error', text: 'usage: /memory on|off|status' })
})

test('on the shipped default the switch is off until /memory on, and "already off" appends nothing', async () => {
  const { commands, commit, projections } = await mount({ enabledByDefault: false }, { withCommands: true })
  const command = commands[0]
  const session = await newRealSession()
  const agent = { session }
  assert.deepEqual(command.handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Claude Code memory is off' })
  assert.deepEqual(command.handler({ agent, rawInput: 'off' }), { kind: 'success', text: 'Claude Code memory is already off' })
  assert.equal(lastModeEvent(session), undefined)
  assert.equal(command.handler({ agent, rawInput: 'on' }).kind, 'success')
  commit(session, lastModeEvent(session))
  assert.deepEqual(projections.read(session, MODE_PROJECTION_KEY), { enabled: true })
  assert.deepEqual(command.handler({ agent, rawInput: 'status' }), { kind: 'success', text: 'Claude Code memory is on' })
})

test('a throwing switch append leaves the mode unchanged and reports an error', async () => {
  const { commands, logs, projections } = await mount({}, { withCommands: true })
  const command = commands[0]
  const session = { id: 'session-test', header: {} }
  const result = command.handler({ agent: { session }, rawInput: 'off' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /session log rejected/)
  assert.deepEqual(projections.read(session, MODE_PROJECTION_KEY), { enabled: null })
  assert.match(logs.at(-1)[1], /cannot store the memory switch/)
})

test('the real projection service restores the switch from the committed log', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await apply(ctx, Config({}))
  const session = ctx.sessions.create(SessionId(`memory-real-${++sessionCounter}`))
  const agent = { id: session.id, session }
  assert.deepEqual(ctx.sessionProjections.snapshot(session).values[MODE_PROJECTION_KEY], { enabled: false })
  const execution = await ctx.commands.execute(agent, '/memory on', [], new AbortController().signal)
  assert.ok(execution)
  assert.equal(execution.result.kind, 'success')
  assert.ok(Number.isInteger(execution.result.sourceEventSeq))
  assert.deepEqual(ctx.sessionProjections.snapshot(session).values[MODE_PROJECTION_KEY], { enabled: true })
  assert.ok(session.snapshotEvents().some((event) => event.type === MODE_EVENT_TYPE && event.ignorable === true))
  const restored = ctx.sessions.create(SessionId(`memory-real-${++sessionCounter}`), { seed: session.snapshotEvents() })
  assert.deepEqual(ctx.sessionProjections.snapshot(restored).values[MODE_PROJECTION_KEY], { enabled: true })
})

test('on the shipped default a session enters nothing until /memory on', async () => {
  const { home, project } = seedProject()
  const { listener, commit } = await mount({ claudeHome: home, enabledByDefault: false })
  const agent = fakeAgent({ cwd: project })
  assert.equal((await run(listener, { agent })).messages.length, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 1, data: { enabled: true } })
  assert.equal((await run(listener, { agent })).messages.length, 2)
})

test('enters the index right after the claimed batch, with a sourced snapshot', async () => {
  const { home, project, path } = seedProject()
  const { listener, logs } = await mount({ claudeHome: home })
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
  const { listener } = await mount({ claudeHome: home })
  const claimed = [userMessage('hi')]
  const decision = await run(listener, { agent: fakeAgent({ cwd: project }), claimed, batch: [structuredClone(claimed[0])] })
  assert.deepEqual(decision.messages.map((message) => message.source.kind), ['user', SOURCE_KIND])
})

test('does not enter the index twice while the visible snapshot is current, re-enters after a change or a covering replace', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, commit } = await mount({ claudeHome: home })
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
  const { listener, commit } = await mount({ claudeHome: home })
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
  const { listener, commit } = await mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 1, data: { enabled: false } })
  assert.equal((await run(listener, { agent })).messages.length, 1)
  commit(agent.session, { type: MODE_EVENT_TYPE, seq: 2, data: { enabled: true } })
  assert.equal((await run(listener, { agent })).messages.length, 2)
})

test('re-enabling with an unchanged index does not re-enter it', async () => {
  const { home, project } = seedProject('- one\n')
  const { listener, commit } = await mount({ claudeHome: home })
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
  const { listener, commit } = await mount({ claudeHome: home })
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
  const { listener, projections } = await mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const original = projections.read
  let modeReads = 0
  projections.read = (session, key) => {
    if (key === MODE_PROJECTION_KEY) {
      modeReads += 1
      if (modeReads === 2) return { enabled: false }
    }
    return original(session, key)
  }
  assert.equal((await run(listener, { agent })).messages.length, 1)
})

test('a snapshot already in the batch is not duplicated', async () => {
  const { home, project } = seedProject()
  const { listener } = await mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const first = await run(listener, { agent })
  const again = await run(listener, { agent, extra: [first.messages[1]] })
  assert.equal(again.messages.length, 2)
})

test('withdraws a shown index once the file disappears or becomes blank, exactly once', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener, commit } = await mount({ claudeHome: home })
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
  const { listener } = await mount({ claudeHome: home })
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: scratch() }) })).messages.length, 1)
})

test('stays out of rejected, later, empty, subagent, cwd-less, and memoryless steps', async () => {
  const { home, project } = seedProject()
  const { listener } = await mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const reject = await listener({ agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
  assert.deepEqual(reject, { kind: 'reject' })
  assert.equal((await run(listener, { agent, step: 2 })).messages.length, 1)
  assert.equal((await run(listener, { agent, claimed: [] })).messages.length, 0)
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: project, origin: 'subagent' }) })).messages.length, 1)
  assert.equal((await run(listener, { agent: fakeAgent({}) })).messages.length, 1, 'no recorded cwd: nothing, never the process directory')
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: scratch() }) })).messages.length, 1)
  const { listener: withSubagents } = await mount({ claudeHome: home, includeSubagents: true })
  assert.equal((await run(withSubagents, { agent: fakeAgent({ cwd: project, origin: 'subagent' }) })).messages.length, 2)
})

test('reuses the rendered index while size and mtime hold, and re-reads when they change', async () => {
  const { home, project, path } = seedProject('- one\n')
  const { listener } = await mount({ claudeHome: home })
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
  const { listener, logs, commit } = await mount({ claudeHome: home })
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
  const { listener, logs, commit } = await mount({ claudeHome: home })
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
  const { listener, logs } = await mount({ claudeHome: home })
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
  const { listener } = await mount({ claudeHome: '~/.claude-does-not-exist-for-this-test' })
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: scratch() }) })).messages.length, 1)
})
