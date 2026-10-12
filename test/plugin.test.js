import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, SOURCE_KIND, apply, inject, name } from '../src/index.js'
import { slugOf } from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-plugin-')))

/** Mount the plugin against a recording context and return the pre-step listener. */
function mount(config = {}) {
  const logs = []
  let listener
  const ctx = {
    logger: { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) },
    on(event, handler) {
      assert.equal(event, 'agent/pre-step')
      listener = handler
      return () => {}
    },
  }
  apply(ctx, Config(config))
  return { listener, logs }
}

const userMessage = (text) => ({ id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function fakeAgent({ cwd, origin, history = [] }) {
  const events = history.map((message) => ({ type: 'user/message', data: message }))
  return {
    session: {
      id: 'session-test',
      header: { cwd, ...(origin === undefined ? {} : { origin }) },
      surface: { nodes: events.map((_, index) => index) },
      eventAt: (seq) => events[seq],
    },
  }
}

async function run(listener, { agent, step = 1, claimed = [userMessage('hi')], extra = [] }) {
  const decision = { kind: 'enter', messages: [...claimed, ...extra] }
  return listener({ agent, messages: claimed, turn: 1, step, signal: new AbortController().signal }, async () => decision)
}

test('exports the plugin identity', () => {
  assert.equal(name, 'claude-memory')
  assert.deepEqual(inject, [])
  assert.equal(SOURCE_KIND, 'plugin:claude-memory')
})

test('Config applies Claude Code defaults and validates caps', () => {
  const resolved = Config({})
  assert.equal(resolved.maxLines, 200)
  assert.equal(resolved.maxBytes, 25 * 1024)
  assert.equal(resolved.includeSubagents, false)
  assert.ok(resolved.claudeHome.endsWith('/.claude'))
  assert.throws(() => Config({ maxLines: 0 }))
  assert.throws(() => Config({ maxBytes: 1.5 }))
})

test('enters the index right after the claimed batch, with a sourced snapshot', async () => {
  const home = scratch()
  const project = scratch()
  const dir = join(home, 'projects', slugOf(project), 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '- [Reply in Chinese](reply-in-chinese.md) — 用中文回复\n')
  const { listener, logs } = mount({ claudeHome: home })
  const runtime = userMessage('runtime')
  const decision = await run(listener, { agent: fakeAgent({ cwd: project }), extra: [runtime] })
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 3)
  const entered = decision.messages[1]
  assert.equal(entered.role, 'user')
  assert.equal(entered.source.kind, SOURCE_KIND)
  assert.equal(entered.source.form, 'snapshot')
  assert.equal(entered.source.path, join(dir, 'MEMORY.md'))
  assert.match(entered.source.digest, /^[0-9a-f]{64}$/)
  assert.ok(entered.content[0].text.includes('- [Reply in Chinese](reply-in-chinese.md) — 用中文回复'))
  assert.ok(entered.content[0].text.includes(`Contents of ${join(dir, 'MEMORY.md')}`))
  assert.equal(decision.messages[2], runtime)
  assert.equal(logs.length, 1)
  assert.equal(logs[0][0], 'info')
})

test('does not enter the index twice while the newest visible snapshot is current, and re-enters when it changes', async () => {
  const home = scratch()
  const project = scratch()
  const dir = join(home, 'projects', slugOf(project), 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '- one\n')
  const { listener } = mount({ claudeHome: home })
  const first = await run(listener, { agent: fakeAgent({ cwd: project }) })
  const snapshot = first.messages[1]
  const again = await run(listener, { agent: fakeAgent({ cwd: project, history: [userMessage('x'), snapshot, userMessage('y')] }) })
  assert.equal(again.messages.length, 1)
  writeFileSync(join(dir, 'MEMORY.md'), '- one\n- two\n')
  const changed = await run(listener, { agent: fakeAgent({ cwd: project, history: [snapshot] }) })
  assert.equal(changed.messages.length, 2)
  assert.notEqual(changed.messages[1].source.digest, snapshot.source.digest)
  const stale = await run(listener, { agent: fakeAgent({ cwd: project, history: [changed.messages[1], snapshot] }) })
  assert.equal(stale.messages.length, 2, 'an older snapshot after the current one does not count as current')
  const batchHas = await run(listener, { agent: fakeAgent({ cwd: project }), extra: [changed.messages[1]] })
  assert.equal(batchHas.messages.length, 2, 'a snapshot already in the batch is not duplicated')
})

test('stays out of rejected, later, empty, subagent, and memoryless steps', async () => {
  const home = scratch()
  const project = scratch()
  const dir = join(home, 'projects', slugOf(project), 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '- one\n')
  const { listener } = mount({ claudeHome: home })
  const agent = fakeAgent({ cwd: project })
  const reject = await listener({ agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
  assert.deepEqual(reject, { kind: 'reject' })
  assert.equal((await run(listener, { agent, step: 2 })).messages.length, 1)
  assert.equal((await run(listener, { agent, claimed: [] })).messages.length, 0)
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: project, origin: 'subagent' }) })).messages.length, 1)
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: scratch() }) })).messages.length, 1)
  const { listener: withSubagents } = mount({ claudeHome: home, includeSubagents: true })
  assert.equal((await run(withSubagents, { agent: fakeAgent({ cwd: project, origin: 'subagent' }) })).messages.length, 2)
})

test('skips a blank index and warns on an unreadable one', async () => {
  const home = scratch()
  const project = scratch()
  const dir = join(home, 'projects', slugOf(project), 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '\n\n')
  const { listener, logs } = mount({ claudeHome: home })
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: project }) })).messages.length, 1)
  assert.equal(logs.length, 0)
  writeFileSync(join(dir, 'MEMORY.md'), Buffer.from([0xff, 0xfe, 0x00]))
  // Still readable as text; make it unreadable by permission instead.
  const { chmodSync } = await import('node:fs')
  chmodSync(join(dir, 'MEMORY.md'), 0o000)
  try {
    const decision = await run(listener, { agent: fakeAgent({ cwd: project }) })
    assert.equal(decision.messages.length, 1)
    assert.equal(logs.at(-1)?.[0], 'warn')
  } finally {
    chmodSync(join(dir, 'MEMORY.md'), 0o644)
  }
})

test('expands ~ in claudeHome', async () => {
  const { listener } = mount({ claudeHome: '~/.claude-does-not-exist-for-this-test' })
  assert.equal((await run(listener, { agent: fakeAgent({ cwd: scratch() }) })).messages.length, 1)
})
