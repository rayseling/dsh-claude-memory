import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, PROJECTION_KEY, SOURCE_KIND, apply, applyProjection, inject, name, projectionStateSchema } from '../src/index.js'
import { slugOf } from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-plugin-')))

/**
 * Mount the plugin against a recording context whose projection registry
 * folds committed events exactly as the host does, and return the pre-step
 * listener plus helpers that commit messages to a fake session.
 */
function mount(config = {}) {
  const logs = []
  let listener
  let definition
  const states = new WeakMap()
  const ctx = {
    logger: { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) },
    on(event, handler) {
      assert.equal(event, 'agent/pre-step')
      listener = handler
      return () => {}
    },
    sessionProjections: {
      register(def) {
        definition = def
        return () => {}
      },
      stateOf(session, key) {
        assert.equal(key, PROJECTION_KEY)
        if (!states.has(session)) states.set(session, definition.init(session.header, 0))
        return states.get(session)
      },
    },
  }
  apply(ctx, Config(config))
  assert.equal(definition.key, PROJECTION_KEY)
  const commit = (session, event) => {
    const prior = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)
    states.set(session, definition.apply(prior, event))
  }
  return { listener, logs, commit, definition }
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
})

test('Config applies Claude Code defaults and validates caps', () => {
  const resolved = Config({})
  assert.equal(resolved.maxLines, 200)
  assert.equal(resolved.maxChars, 25_000)
  assert.equal(resolved.includeSubagents, false)
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
  assert.deepEqual(applyProjection(seen, covering), empty)
  const notice = { type: 'user/message', seq: 7, surfaceOp: 'append', data: { source: { kind: SOURCE_KIND, form: 'notice', summary: 's' } } }
  assert.equal(applyProjection(seen, notice), seen)
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
