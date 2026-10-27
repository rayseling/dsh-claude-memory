import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  MEMORY_TYPES, deleteMemory, isMemoryName, judgeIndex, removeIndexLine, renderIndexLine, renderMemoryFile, saveMemory, upsertIndexLine, withStoreLock,
} from '../src/store.js'
import { Config, DELETE_TOOL_NAME, SAVE_TOOL_NAME, apply } from '../src/index.js'
import { slugOf } from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-store-')))

test('memory names are lower-case kebab-case', () => {
  for (const ok of ['a', 'reply-in-chinese', 'dsh-0-2-1']) assert.equal(isMemoryName(ok), true, ok)
  for (const bad of ['', 'Reply', 'a--b', '-a', 'a-', 'a_b', 'a b', 'a/b', '../x', 'a.md', 'x'.repeat(101)]) assert.equal(isMemoryName(bad), false, bad)
  assert.deepEqual([...MEMORY_TYPES], ['user', 'feedback', 'project', 'reference'])
})

test('judgeIndex is ok below nine tenths of both caps, near from nine tenths, over past either cap', () => {
  const limits = { maxLines: 200, maxChars: 25_000 }
  assert.equal(judgeIndex({ indexLines: 179, indexChars: 22_499 }, limits), 'ok')
  assert.equal(judgeIndex({ indexLines: 180, indexChars: 10 }, limits), 'near')
  assert.equal(judgeIndex({ indexLines: 10, indexChars: 22_500 }, limits), 'near')
  assert.equal(judgeIndex({ indexLines: 200, indexChars: 25_000 }, limits), 'near', 'exactly at the cap still loads in full')
  assert.equal(judgeIndex({ indexLines: 201, indexChars: 10 }, limits), 'over')
  assert.equal(judgeIndex({ indexLines: 10, indexChars: 25_001 }, limits), 'over')
})

test('renderMemoryFile writes Claude Code frontmatter with the host-filled fields and a trimmed body', () => {
  const text = renderMemoryFile({
    name: 'deploy-host', description: 'Where: the deploy box\nis mini', type: 'project', content: '\n部署机是 mini。\n\n**Why:** 只有它有公网。\n', sessionId: 's-1', modified: new Date('2026-10-26T06:00:00Z'),
  })
  assert.equal(text, [
    '---',
    'name: deploy-host',
    'description: "Where: the deploy box is mini"',
    'metadata:',
    '  node_type: memory',
    '  type: project',
    '  originSessionId: s-1',
    '  modified: 2026-10-26T06:00:00.000Z',
    '---',
    '',
    '部署机是 mini。\n\n**Why:** 只有它有公网。',
    '',
  ].join('\n'))
})

test('index lines are upserted by link target and removed by it, keeping the rest byte for byte', () => {
  const line = renderIndexLine({ name: 'deploy-host', title: 'Deploy [host]', hook: 'the box\nis mini' })
  assert.equal(line, '- [Deploy host](deploy-host.md) — the box is mini')
  const fresh = upsertIndexLine('', 'deploy-host', line)
  assert.deepEqual(fresh, { text: `${line}\n`, replaced: false, lines: 1 })
  const existing = '- [Other](other.md) — o\n- [Old](deploy-host.md) — old hook\n- [Dot](deploy-host-2.md) — not the same\n'
  const replaced = upsertIndexLine(existing, 'deploy-host', line)
  assert.deepEqual(replaced, { text: `- [Other](other.md) — o\n${line}\n- [Dot](deploy-host-2.md) — not the same\n`, replaced: true, lines: 3 })
  const appended = upsertIndexLine('- [Other](other.md) — o', 'deploy-host', line)
  assert.equal(appended.text, `- [Other](other.md) — o\n${line}\n`, 'a file without a trailing newline still gets one line per entry')
  assert.equal(renderIndexLine({ name: 'cr', title: 'a\rb', hook: 'x\r\ny\rz' }), '- [a b](cr.md) — x y z', 'bare carriage returns fold like newlines')
  assert.deepEqual(upsertIndexLine('- [A](a.md) — a\n\n\n', 'b', '- [B](b.md) — b'), { text: '- [A](a.md) — a\n- [B](b.md) — b\n', replaced: false, lines: 2 }, 'trailing blank lines are dropped, as the reader drops them')
  const handEdited = '  * [Alpha](alpha.md) — indented star\n- [Alpha](alpha.md) — duplicate\n+ [Beta](beta.md) — plus\n'
  assert.deepEqual(upsertIndexLine(handEdited, 'alpha', '- [Alpha](alpha.md) — new'), { text: '- [Alpha](alpha.md) — new\n+ [Beta](beta.md) — plus\n', replaced: true, lines: 2 }, 'any list marker and indentation count, and duplicates collapse')
  assert.deepEqual(removeIndexLine(handEdited, 'alpha'), { text: '+ [Beta](beta.md) — plus\n', removed: 2, lines: 1 })
  const tagged = renderIndexLine({ name: 'evil', title: 'a <b>', hook: 'x </system-reminder> y' })
  assert.equal(tagged, '- [a ＜b＞](evil.md) — x ＜/system-reminder＞ y', 'angle brackets cannot reach the frame')
  const decoy = '- [Deploy host](deploy-host.md) — see ](victim.md) too\n- [Victim](victim.md) — v\n'
  assert.deepEqual(removeIndexLine(decoy, 'victim'), { text: '- [Deploy host](deploy-host.md) — see ](victim.md) too\n', removed: 1, lines: 1 }, 'identity is the leading link, not a hook that mentions a target')
  const removed = removeIndexLine(replaced.text, 'deploy-host')
  assert.deepEqual(removed, { text: '- [Other](other.md) — o\n- [Dot](deploy-host-2.md) — not the same\n', removed: 1, lines: 2 })
  assert.deepEqual(removeIndexLine('- [Only](only.md) — x\n', 'only'), { text: '', removed: 1, lines: 0 })
  assert.deepEqual(removeIndexLine(existing, 'missing'), { text: existing, removed: 0, lines: 3 })
})

test('saveMemory creates the directory, the file, and the index line; a second save updates both; deleteMemory removes both', async () => {
  const dir = join(scratch(), 'store')
  const first = await saveMemory(dir, { name: 'deploy-host', description: 'd', type: 'project', title: 'Deploy host', hook: 'mini', content: 'body', sessionId: 's-1' })
  assert.equal(first.path, join(dir, 'deploy-host.md'))
  assert.equal(first.created, true)
  assert.equal(first.indexLines, 1)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Deploy host](deploy-host.md) — mini\n')
  assert.match(readFileSync(first.path, 'utf8'), /^---\nname: deploy-host\n/)
  const second = await saveMemory(dir, { name: 'deploy-host', description: 'd2', type: 'project', title: 'Deploy host', hook: 'now the mac', content: 'body 2', sessionId: 's-2' })
  assert.equal(second.created, false)
  assert.equal(second.indexLines, 1)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Deploy host](deploy-host.md) — now the mac\n')
  assert.match(readFileSync(first.path, 'utf8'), /originSessionId: s-2\n/)
  await saveMemory(dir, { name: 'other', description: 'o', type: 'user', title: 'Other', hook: 'o', content: 'o', sessionId: 's-1' })
  assert.deepEqual(readdirSync(dir).sort(), ['MEMORY.md', 'deploy-host.md', 'other.md'], 'no temp file is left behind')
  const removed = await deleteMemory(dir, 'deploy-host')
  assert.deepEqual(removed, { path: first.path, indexPath: join(dir, 'MEMORY.md'), removedFile: true, removedLines: 1, indexLines: 1 })
  assert.equal(existsSync(first.path), false)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Other](other.md) — o\n')
  const again = await deleteMemory(dir, 'deploy-host')
  assert.deepEqual(again, { path: first.path, indexPath: join(dir, 'MEMORY.md'), removedFile: false, removedLines: 0, indexLines: 1 }, 'deleting a missing memory is not an error')
  const nowhere = join(scratch(), 'never-created')
  assert.equal((await deleteMemory(nowhere, 'x')).removedFile, false)
  assert.equal(existsSync(nowhere), false, 'a delete does not create a store')
})

test('concurrent saves to one directory all land in the index', async () => {
  const dir = join(scratch(), 'store')
  await Promise.all(Array.from({ length: 8 }, (_, index) => saveMemory(dir, {
    name: `entry-${index}`, description: 'd', type: 'reference', title: `Entry ${index}`, hook: 'h', content: 'c', sessionId: 's',
  })))
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean).length, 8)
  assert.equal(existsSync(join(dir, '.MEMORY.lock')), false, 'the lock is released')
})

test('saves from two processes all land in the index (web and headless share one store)', async () => {
  const dir = join(scratch(), 'store')
  const script = join(scratch(), 'save-many.mjs')
  writeFileSync(script, [
    `import { saveMemory } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)}`,
    'const [dir, prefix, count] = process.argv.slice(2)',
    'for (let index = 0; index < Number(count); index += 1) {',
    '  await saveMemory(dir, { name: `${prefix}-${index}`, description: "d", type: "project", title: `${prefix} ${index}`, hook: "h", content: "c", sessionId: prefix })',
    '}',
  ].join('\n'))
  const { execFile } = await import('node:child_process')
  const run = (prefix) => new Promise((resolve, reject) => {
    execFile(process.execPath, [script, dir, prefix, '20'], (error, _stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve())
  })
  await Promise.all([run('web'), run('headless')])
  const lines = readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 40, 'no index update is lost to a concurrent rewrite')
  assert.equal(readdirSync(dir).filter((entry) => entry.endsWith('.md') && entry !== 'MEMORY.md').length, 40)
  assert.equal(existsSync(join(dir, '.MEMORY.lock')), false)
})

test('a stale lock left by a dead process is taken over', async () => {
  const dir = join(scratch(), 'store')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.MEMORY.lock'), '1\n')
  const { utimesSync } = await import('node:fs')
  const old = (Date.now() - 60_000) / 1000
  utimesSync(join(dir, '.MEMORY.lock'), old, old)
  const saved = await saveMemory(dir, { name: 'after-crash', description: 'd', type: 'project', title: 't', hook: 'h', content: 'c', sessionId: 's' })
  assert.equal(saved.created, true)
  assert.equal(existsSync(join(dir, '.MEMORY.lock')), false)
  assert.deepEqual(readdirSync(dir).filter((entry) => entry.startsWith('.MEMORY')), [], 'no takeover or graveyard file is left behind')
})

/** Run `count` critical sections through `withStoreLock` and record whether any two overlapped. */
async function contend(dir, count, timing, hold = 15) {
  let active = 0
  let overlaps = 0
  let runs = 0
  await Promise.all(Array.from({ length: count }, () => withStoreLock(dir, async () => {
    active += 1
    if (active > 1) overlaps += 1
    await new Promise((resolve) => setTimeout(resolve, hold))
    active -= 1
    runs += 1
  }, timing)))
  return { overlaps, runs }
}

test('two waiters that both find the same abandoned lock never both take it over', async () => {
  const dir = join(scratch(), 'store')
  mkdirSync(dir, { recursive: true })
  const { utimesSync } = await import('node:fs')
  for (let round = 0; round < 10; round += 1) {
    writeFileSync(join(dir, '.MEMORY.lock'), 'dead\n')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(join(dir, '.MEMORY.lock'), old, old)
    const { overlaps, runs } = await contend(dir, 4, { staleMs: 200, waitMs: 5000 })
    assert.equal(runs, 4)
    assert.equal(overlaps, 0, `round ${round}: critical sections overlapped after a takeover`)
    assert.equal(existsSync(join(dir, '.MEMORY.lock')), false)
  }
})

test('a live holder keeps its lock past the stale window by heartbeat, and a release never removes another writer\'s lock', async () => {
  const dir = join(scratch(), 'store')
  mkdirSync(dir, { recursive: true })
  const timing = { staleMs: 120, waitMs: 5000 }
  const { overlaps, runs } = await contend(dir, 2, timing, 300)
  assert.equal(runs, 2)
  assert.equal(overlaps, 0, 'a holder writing longer than the stale window is not taken over while it heartbeats')

  const lockPath = join(dir, '.MEMORY.lock')
  await withStoreLock(dir, async () => {
    writeFileSync(lockPath, 'someone-else\n')
  }, timing)
  assert.equal(readFileSync(lockPath, 'utf8'), 'someone-else\n', 'the release checked ownership and left the other token in place')
  rmSync(lockPath)
})

test('saves from two processes with an abandoned lock in place all land in the index', async () => {
  const dir = join(scratch(), 'store')
  mkdirSync(dir, { recursive: true })
  const script = join(scratch(), 'save-many.mjs')
  writeFileSync(script, [
    `import { saveMemory } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)}`,
    'const [dir, prefix, count] = process.argv.slice(2)',
    'for (let index = 0; index < Number(count); index += 1) {',
    '  await saveMemory(dir, { name: `${prefix}-${index}`, description: "d", type: "project", title: `${prefix} ${index}`, hook: "h", content: "c", sessionId: prefix })',
    '}',
  ].join('\n'))
  const { execFile } = await import('node:child_process')
  const { utimesSync } = await import('node:fs')
  const run = (prefix) => new Promise((resolve, reject) => {
    execFile(process.execPath, [script, dir, prefix, '20'], (error, _stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve())
  })
  for (let round = 0; round < 3; round += 1) {
    writeFileSync(join(dir, '.MEMORY.lock'), 'dead\n')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(join(dir, '.MEMORY.lock'), old, old)
    await Promise.all([run(`web${round}`), run(`headless${round}`)])
    const lines = readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 40 * (round + 1), `round ${round}: an index update was lost during takeover`)
  }
})

test('the reserved name "memory" is refused before anything touches the disk', async () => {
  for (const name of ['memory', 'MEMORY', 'Memory']) assert.equal(isMemoryName(name), false, name)
  const dir = join(scratch(), 'store')
  await saveMemory(dir, { name: 'alpha', description: 'd', type: 'project', title: 'Alpha', hook: 'a', content: 'c', sessionId: 's' })
  await saveMemory(dir, { name: 'beta', description: 'd', type: 'project', title: 'Beta', hook: 'b', content: 'c', sessionId: 's' })
  const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  await assert.rejects(saveMemory(dir, { name: 'memory', description: 'd', type: 'project', title: 'x', hook: 'x', content: 'c', sessionId: 's' }), TypeError)
  await assert.rejects(deleteMemory(dir, 'memory'), TypeError)
  await assert.rejects(deleteMemory(dir, 'Bad Name'), TypeError)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), before, 'the index is untouched on a case-insensitive file system')
  assert.deepEqual(readdirSync(dir).sort(), ['MEMORY.md', 'alpha.md', 'beta.md'])
})

/** Mount the plugin on a real tool runtime with a real session store, as the host composes them. */
async function mountWithTools(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  apply(ctx, Config(config))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return ctx
}

let calls = 0
const call = (ctx, name, args, agent) => ctx.tools.execute({
  signal: new AbortController().signal, callId: `call-${++calls}`, name, arguments: args, ...(agent === undefined ? {} : { agent }),
})
const text = (result) => result.content.filter((block) => block.type === 'text').map((block) => block.text).join('')

test('memory_save and memory_delete write the calling session\'s own store through the real tool runtime', async () => {
  const ownHome = scratch()
  const project = scratch()
  const ctx = await mountWithTools({ ownMemory: true, ownMemoryHome: ownHome, maxLines: 4 })
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith('memory_')).sort(), [DELETE_TOOL_NAME, SAVE_TOOL_NAME])
  const saveSchema = ctx.tools.schemas().find((schema) => schema.name === SAVE_TOOL_NAME)
  assert.deepEqual(Object.keys(saveSchema.parameters.properties).sort(), ['content', 'description', 'hook', 'name', 'title', 'type'])
  assert.deepEqual(saveSchema.parameters.properties.type.enum, ['user', 'feedback', 'project', 'reference'])

  const session = ctx.sessions.create(SessionId('memory-tool-1'), { meta: { cwd: project } })
  const agent = { id: session.id, session }
  const dir = join(ownHome, slugOf(project))
  const saved = await call(ctx, SAVE_TOOL_NAME, { name: 'deploy-host', type: 'project', title: 'Deploy host', description: 'd', hook: 'mini', content: 'body' }, agent)
  assert.equal(saved.isError, false, JSON.stringify(saved))
  const indexText = '- [Deploy host](deploy-host.md) — mini\n'
  assert.deepEqual(saved.value, { path: join(dir, 'deploy-host.md'), created: true, indexLines: 1, indexChars: indexText.length - 1, indexNote: '' }, 'characters are counted without the final newline')
  assert.equal(text(saved), `Saved memory deploy-host at ${join(dir, 'deploy-host.md')}.`)
  assert.match(readFileSync(join(dir, 'deploy-host.md'), 'utf8'), /originSessionId: memory-tool-1\n/)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), indexText)

  for (const name of ['two', 'three']) assert.equal((await call(ctx, SAVE_TOOL_NAME, { name, type: 'user', title: name, description: 'd', hook: 'h', content: 'c' }, agent)).value.indexNote, '')
  const near = await call(ctx, SAVE_TOOL_NAME, { name: 'four', type: 'user', title: 'four', description: 'd', hook: 'h', content: 'c' }, agent)
  assert.equal(near.isError, false)
  assert.match(text(near), /The index is at 4 lines \/ \d+ characters, near its 4 lines \/ 25000 characters read limit: keep one line per entry/)
  const over = await call(ctx, SAVE_TOOL_NAME, { name: 'five', type: 'user', title: 'five', description: 'd', hook: 'h', content: 'c' }, agent)
  assert.equal(over.isError, true, 'over the cap the tool reports an error')
  assert.match(text(over), /the memory was saved, but this write left the index .*MEMORY.md at 5 lines \/ \d+ characters, over its 4 lines \/ 25000 characters read limit; everything past the limit is dropped on the next load/)
  assert.ok(existsSync(join(dir, 'five.md')), 'the write itself stands')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean).length, 5)
  assert.equal((await call(ctx, DELETE_TOOL_NAME, { name: 'five' }, agent)).isError, false)

  const badName = await call(ctx, SAVE_TOOL_NAME, { name: 'Bad Name', type: 'user', title: 't', description: 'd', hook: 'h', content: 'c' }, agent)
  assert.equal(badName.isError, true)
  assert.match(text(badName), /kebab-case/)
  const badType = await call(ctx, SAVE_TOOL_NAME, { name: 'ok', type: 'misc', title: 't', description: 'd', hook: 'h', content: 'c' }, agent)
  assert.equal(badType.isError, true, 'the registry enforces the type enum')
  const noAgent = await call(ctx, SAVE_TOOL_NAME, { name: 'ok', type: 'user', title: 't', description: 'd', hook: 'h', content: 'c' })
  assert.equal(noAgent.isError, true)
  assert.match(text(noAgent), /working directory/)

  const removed = await call(ctx, DELETE_TOOL_NAME, { name: 'deploy-host' }, agent)
  assert.equal(removed.isError, false)
  assert.deepEqual(removed.value, { path: join(dir, 'deploy-host.md'), existed: true, indexLines: 3 })
  assert.equal(text(removed), 'Deleted memory deploy-host.')
  assert.equal(existsSync(join(dir, 'deploy-host.md')), false)
  const missing = await call(ctx, DELETE_TOOL_NAME, { name: 'deploy-host' }, agent)
  assert.equal(missing.isError, false)
  assert.equal(missing.value.existed, false)
  assert.match(text(missing), /nothing to delete/)
})

test('unloading the real tool runtime makes the next message say the store cannot be written', async () => {
  const ownHome = scratch()
  const project = scratch()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  const runtime = await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  apply(ctx, Config({ ownMemory: true, ownMemoryHome: ownHome, readByDefault: { claude: false, dsh: true } }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const session = ctx.sessions.create(SessionId('memory-unload-1'), { meta: { cwd: project } })
  const agent = { id: session.id, session }
  const user = { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const step = () => ctx.waterfall('agent/pre-step', { agent, messages: [user], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
  const before = await step()
  assert.equal(before.messages.length, 2)
  assert.ok(before.messages[1].content[0].text.includes('memory_save'), 'with the runtime loaded the tools are taught')
  assert.ok(ctx.tools.schemas().some((schema) => schema.name === SAVE_TOOL_NAME))
  await runtime.dispose()
  assert.equal(ctx.get('tools'), undefined, 'the tool service is gone')
  const after = await step()
  const text = after.messages[1].content[0].text
  assert.ok(text.includes('This host offers no memory tools'), 'the effect disposer reset the flag when the scope unloaded')
  assert.ok(!text.includes('memory_save'))
})

test('the tools write to the main repository\'s store from a linked worktree, and are absent without an own store', async () => {
  const ownHome = scratch()
  const main = scratch()
  mkdirSync(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
  writeFileSync(join(main, '.git', 'worktrees', 'feat', 'commondir'), '../..\n')
  const wt = join(main, '.claude', 'worktrees', 'feat')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  const ctx = await mountWithTools({ ownMemory: true, ownMemoryHome: ownHome })
  const session = ctx.sessions.create(SessionId('memory-tool-wt'), { meta: { cwd: wt } })
  const saved = await call(ctx, SAVE_TOOL_NAME, { name: 'shared', type: 'project', title: 'Shared', description: 'd', hook: 'h', content: 'c' }, { id: session.id, session })
  assert.equal(saved.value.path, join(ownHome, slugOf(main), 'shared.md'))

  const without = await mountWithTools({ ownMemory: false })
  assert.equal(without.tools.schemas().some((schema) => schema.name.startsWith('memory_')), false)
})
