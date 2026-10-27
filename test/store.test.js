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
  MEMORY_TYPES, deleteMemory, indexLineName, indexOrder, isEntryName, isMemoryName, judgeIndex, listEntries, parseFrontmatter, projectIndex, renderIndex, renderIndexLine,
  renderMemoryFile, saveMemory, syncIndex,
} from '../src/store.js'
import { Config, DELETE_TOOL_NAME, SAVE_TOOL_NAME, apply } from '../src/index.js'
import { slugOf } from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-store-')))

test('memory names are lower-case kebab-case; entry names are any safe file stem', () => {
  for (const ok of ['a', 'reply-in-chinese', 'dsh-0-2-1']) assert.equal(isMemoryName(ok), true, ok)
  for (const bad of ['', 'Reply', 'a--b', '-a', 'a-', 'a_b', 'a b', 'a/b', '../x', 'a.md', 'x'.repeat(101)]) assert.equal(isMemoryName(bad), false, bad)
  for (const ok of ['a', 'reply-in-chinese', 'feedback_testing', 'Reply', 'a.b', 'a--b', 'a-']) assert.equal(isEntryName(ok), true, ok)
  for (const bad of ['', '.hidden', '..', 'a b', 'a/b', 'a\\b', 'a(b)', 'a[b]', 'memory', 'MEMORY', 'x'.repeat(101)]) assert.equal(isEntryName(bad), false, bad)
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
    name: 'deploy-host', description: 'Where: the deploy box\nis mini', title: 'Deploy host', hook: 'it is mini', type: 'project', content: '\n部署机是 mini。\n\n**Why:** 只有它有公网。\n', sessionId: 's-1', modified: new Date('2026-10-26T06:00:00Z'),
  })
  assert.equal(text, [
    '---',
    'name: deploy-host',
    'description: "Where: the deploy box is mini"',
    'title: "Deploy host"',
    'hook: "it is mini"',
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

test('index lines render safely, identify their entry by the leading link, and keep the previous order', () => {
  const line = renderIndexLine({ name: 'deploy-host', title: 'Deploy [host]', hook: 'the box\nis mini' })
  assert.equal(line, '- [Deploy host](deploy-host.md) — the box is mini')
  assert.equal(renderIndexLine({ name: 'cr', title: 'a\rb', hook: 'x\r\ny\rz' }), '- [a b](cr.md) — x y z', 'bare carriage returns fold like newlines')
  assert.equal(renderIndexLine({ name: 'evil', title: 'a <b>', hook: 'x </system-reminder> y' }), '- [a ＜b＞](evil.md) — x ＜/system-reminder＞ y', 'angle brackets cannot reach the frame')
  assert.equal(indexLineName('- [Deploy host](deploy-host.md) — see ](victim.md) too'), 'deploy-host', 'identity is the leading link, not a hook that mentions a target')
  assert.equal(indexLineName('  * [Alpha](alpha.md) — indented star'), 'alpha')
  assert.equal(indexLineName('+ [Beta](beta.md) — plus'), 'beta')
  assert.equal(indexLineName('see [Alpha](alpha.md)'), undefined)
  assert.equal(indexLineName('- [x](../x.md)'), undefined)
  assert.deepEqual(indexOrder('- [B](b.md) — b\r\n- [A](a.md) — a\n- [B](b.md) — again\n\n'), ['b', 'a'], 'each name once, CRLF tolerated')
  const entries = [
    { name: 'a', title: 'A', hook: 'a', mtimeMs: 3 },
    { name: 'b', title: 'B', hook: 'b', mtimeMs: 1 },
    { name: 'c', title: 'C', hook: 'c', mtimeMs: 2 },
  ]
  assert.equal(renderIndex(entries, '- [C](c.md) — old\n- [gone](gone.md) — x\n'), '- [C](c.md) — c\n- [B](b.md) — b\n- [A](a.md) — a\n', 'listed names first in their order, then new ones by write time')
  assert.equal(renderIndex([], '- [gone](gone.md) — x\n'), '')
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
  assert.deepEqual(removed, { path: first.path, indexPath: join(dir, 'MEMORY.md'), removedFile: true, indexLines: 1 })
  assert.equal(existsSync(first.path), false)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Other](other.md) — o\n')
  const again = await deleteMemory(dir, 'deploy-host')
  assert.deepEqual(again, { path: first.path, indexPath: join(dir, 'MEMORY.md'), removedFile: false, indexLines: 1 }, 'deleting a missing memory is not an error')
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
  assert.deepEqual(readdirSync(dir).filter((entry) => entry.startsWith('.')), [], 'no temp files are left behind')
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
  assert.equal(readdirSync(dir).filter((entry) => entry.endsWith('.md') && entry !== 'MEMORY.md').length, 40)
  assert.equal((await projectIndex(dir)).indexLines, 40, 'the reader sees every entry whatever the two writers left on disk')
  const synced = await syncIndex(dir)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), synced.text, 'a read repairs the file')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean).length, 40)
  assert.deepEqual(readdirSync(dir).filter((entry) => entry.startsWith('.')), [], 'no temp or lock files are left behind')
})

test('the reader projects the index from the entry files, so an index file an overlapping or interrupted write left behind hides nothing', async () => {
  const dir = join(scratch(), 'store')
  for (const name of ['a', 'b-1', 'b-2']) await saveMemory(dir, { name, description: 'd', type: 'project', title: name.toUpperCase(), hook: `hook ${name}`, content: 'c', sessionId: 's' })
  const complete = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  // The loser of an overlapping rebuild wrote a listing taken before b-2 existed.
  writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — hook a\n- [B-1](b-1.md) — hook b-1\n')
  let index = await projectIndex(dir)
  assert.equal(index.text, complete)
  assert.equal(index.stale, true)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('b-2'), false, 'projecting does not write')
  const synced = await syncIndex(dir)
  assert.equal(synced.written, true)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), complete)
  assert.equal((await syncIndex(dir)).written, false, 'an index that agrees with its entries is left alone')
  // A writer that crashed between its entry file and the index: the entry is listed on the next read.
  writeFileSync(join(dir, 'c.md'), renderMemoryFile({ name: 'c', description: 'd', title: 'C', hook: 'hook c', type: 'user', content: 'c', sessionId: 's', modified: new Date() }))
  rmSync(join(dir, 'MEMORY.md'))
  index = await projectIndex(dir)
  assert.deepEqual(indexOrder(index.text), ['a', 'b-1', 'b-2', 'c'], 'without a previous index the entries follow their write order')
  // A stale line for an entry whose file changed is replaced by the file's fields.
  writeFileSync(join(dir, 'MEMORY.md'), '- [C](c.md) — OLD\n')
  await saveMemory(dir, { name: 'c', description: 'd', type: 'user', title: 'C', hook: 'NEW', content: 'c', sessionId: 's', modified: new Date(0) })
  assert.ok(readFileSync(join(dir, 'MEMORY.md'), 'utf8').startsWith('- [C](c.md) — NEW\n'))
  assert.equal((await projectIndex(join(scratch(), 'never'))).text, '', 'an absent store projects to no entries')
})

test('hand-written entries keep the index line they have, index under name and description without one, and are deletable', async () => {
  const dir = join(scratch(), 'store')
  mkdirSync(dir, { recursive: true })
  // Copied from Claude Code: not kebab-case, no title or hook, and a block-scalar description.
  writeFileSync(join(dir, 'feedback_testing.md'), '---\nname: feedback_testing\ndescription: |-\n  run the\n  tests first\nmetadata:\n  type: feedback\n---\n\nbody\n')
  writeFileSync(join(dir, 'old-entry.md'), '---\nname: old-entry\ndescription: "from 0.4.0"\n---\n\nbody\n')
  writeFileSync(join(dir, 'MEMORY.md'), '- [Old entry, as written by hand](old-entry.md) — a hand-written hook\n')
  assert.equal((await projectIndex(dir)).text, '- [Old entry, as written by hand](old-entry.md) — a hand-written hook\n- [feedback_testing](feedback_testing.md) — run the tests first\n')
  const saved = await saveMemory(dir, { name: 'tooled', description: 'd', type: 'project', title: 'Tooled', hook: 't', content: 'c', sessionId: 's' })
  assert.equal(saved.indexLines, 3)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Old entry, as written by hand](old-entry.md) — a hand-written hook\n- [feedback_testing](feedback_testing.md) — run the tests first\n- [Tooled](tooled.md) — t\n')
  const removed = await deleteMemory(dir, 'feedback_testing')
  assert.equal(removed.removedFile, true)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Old entry, as written by hand](old-entry.md) — a hand-written hook\n- [Tooled](tooled.md) — t\n')
  await assert.rejects(saveMemory(dir, { name: 'feedback_testing', description: 'd', type: 'project', title: 'x', hook: 'x', content: 'c', sessionId: 's' }), TypeError, 'the save tool still names new entries in kebab-case')
})

test('an entry that cannot be read is reported and skipped, and neither blocks the index nor a save or delete', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root reads every file')
  const dir = join(scratch(), 'store')
  for (const name of ['readable', 'locked']) await saveMemory(dir, { name, description: 'd', type: 'project', title: name, hook: 'h', content: 'c', sessionId: 's' })
  const { chmodSync, symlinkSync } = await import('node:fs')
  symlinkSync(join(dir, 'readable.md'), join(dir, 'linked.md'))
  chmodSync(join(dir, 'locked.md'), 0o000)
  try {
    const listed = await listEntries(dir)
    assert.deepEqual(listed.entries.map((entry) => entry.name), ['readable'], 'symbolic links are not followed')
    assert.deepEqual(listed.skipped.map((entry) => [entry.name, entry.reason, entry.error.code]), [['linked', 'unreadable', 'ENOTREG'], ['locked', 'unreadable', 'EACCES']])
    const index = await projectIndex(dir)
    assert.equal(index.text, '- [readable](readable.md) — h\n- [locked](locked.md) — h\n', 'the unreadable entry keeps the line the cache had for it')
    assert.deepEqual(index.omitted.map((entry) => entry.name), ['linked'], 'only a skipped file without a cached line is missing from the projection')
    const saved = await saveMemory(dir, { name: 'more', description: 'd', type: 'project', title: 'More', hook: 'h', content: 'c', sessionId: 's' })
    assert.equal(saved.indexLines, 3)
    assert.equal(saved.indexError, undefined)
    await deleteMemory(dir, 'readable')
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [locked](locked.md) — h\n- [More](more.md) — h\n')
  } finally {
    chmodSync(join(dir, 'locked.md'), 0o644)
  }
  const back = await projectIndex(dir)
  assert.equal(back.text, '- [locked](locked.md) — h\n- [More](more.md) — h\n', 'readable again, the entry renders from its file in its old place')
  assert.deepEqual(back.skipped.map((entry) => entry.name), ['linked'])
})

test('the index is a projection of the entry files, rebuilt on every write', async () => {
  const dir = join(scratch(), 'store')
  await saveMemory(dir, { name: 'alpha', description: 'da', type: 'project', title: 'Alpha', hook: 'a', content: 'c', sessionId: 's' })
  await saveMemory(dir, { name: 'beta', description: 'db', type: 'project', title: 'Beta', hook: 'b', content: 'c', sessionId: 's' })
  // A hand-written entry without the index fields indexes under its name and description; a stray file is ignored.
  writeFileSync(join(dir, 'gamma.md'), '---\nname: gamma\ndescription: "hand: written"\n---\n\nbody\n')
  writeFileSync(join(dir, 'notes.txt'), 'not a memory')
  writeFileSync(join(dir, 'Bad Name.md'), 'not a memory either')
  writeFileSync(join(dir, '.hidden.md'), 'nor this')
  // A hand edit to the index itself is replaced on the next write; its order survives, CRLF or not.
  writeFileSync(join(dir, 'MEMORY.md'), '- [Beta](beta.md) — edited by hand\r\n- [Alpha](alpha.md) — a\r\n')
  const saved = await saveMemory(dir, { name: 'delta', description: 'dd', type: 'project', title: 'Delta', hook: 'd', content: 'c', sessionId: 's' })
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), [
    '- [Beta](beta.md) — b',
    '- [Alpha](alpha.md) — a',
    '- [gamma](gamma.md) — hand: written',
    '- [Delta](delta.md) — d',
    '',
  ].join('\n'), 'listed names keep their order, the hand edit to beta is replaced by its file, new entries follow by write time')
  assert.equal(saved.indexLines, 4)
  await deleteMemory(dir, 'gamma')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Beta](beta.md) — b\n- [Alpha](alpha.md) — a\n- [Delta](delta.md) — d\n')
  // An index that went missing is rebuilt in full by the next write.
  rmSync(join(dir, 'MEMORY.md'))
  await saveMemory(dir, { name: 'alpha', description: 'da', type: 'project', title: 'Alpha', hook: 'a2', content: 'c', sessionId: 's' })
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean).length, 3)
})

test('parseFrontmatter reads the scalar fields this store writes and tolerates hand-written files', () => {
  const text = renderMemoryFile({ name: 'n', description: 'd: x', title: 'T "q"', hook: 'h', type: 'user', content: 'c', sessionId: 's', modified: new Date(0) })
  const fields = parseFrontmatter(text)
  assert.equal(fields.name, 'n')
  assert.equal(fields.description, 'd: x')
  assert.equal(fields.title, 'T "q"')
  assert.equal(fields.hook, 'h')
  assert.equal(fields.metadata, undefined, 'nested blocks are not flattened')
  assert.deepEqual(parseFrontmatter('no frontmatter\n'), {})
  assert.deepEqual(parseFrontmatter('---\r\nname: crlf\r\ntitle: bare value\r\n---\r\nbody'), { name: 'crlf', title: 'bare value' })
  assert.deepEqual(parseFrontmatter('---\nname: x\n---'), { name: 'x' }, 'a frontmatter block that ends the file')
  assert.deepEqual(parseFrontmatter('﻿---\nname: bom\n---\n'), { name: 'bom' }, 'a byte order mark is ignored')
  assert.deepEqual(parseFrontmatter("---\ntitle: 'it''s quoted'\nhook: bare # a comment\nempty:\n---\n"), { title: "it's quoted", hook: 'bare' })
  assert.deepEqual(
    parseFrontmatter('---\ntitle: "a # not a comment" # a comment\nhook: \'b\' # c\ndescription: "" # empty\nname: null\nextra: ~\nlist: []\nmap: {}\nkeep: "x\\"y"\n---\n'),
    { title: 'a # not a comment', hook: 'b', keep: 'x"y' },
    'a comment after a quoted scalar is dropped; empty and null values are absent',
  )
  assert.deepEqual(
    parseFrontmatter('---\ndescription: |-\n  first line\n\n  third: line\nhook: >\n  folded\n  text\ntitle: after\n---\n'),
    { description: 'first line\n\nthird: line', hook: 'folded text', title: 'after' },
    'block scalars take their indented lines',
  )
})

test('concurrent saves and deletes from two processes converge on a complete index', async () => {
  const dir = join(scratch(), 'store')
  const script = join(scratch(), 'churn.mjs')
  writeFileSync(script, [
    `import { saveMemory, deleteMemory } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)}`,
    'const [dir, prefix, count, mode] = process.argv.slice(2)',
    'for (let index = 0; index < Number(count); index += 1) {',
    '  await saveMemory(dir, { name: `${prefix}-${index}`, description: "d", type: "project", title: `${prefix} ${index}`, hook: "h", content: "c", sessionId: prefix })',
    '  if (mode === "churn" && index % 2 === 1) await deleteMemory(dir, `${prefix}-${index - 1}`)',
    '}',
  ].join('\n'))
  const { execFile } = await import('node:child_process')
  const run = (prefix, mode) => new Promise((resolve, reject) => {
    execFile(process.execPath, [script, dir, prefix, '20', mode], (error, _stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve())
  })
  for (let round = 0; round < 3; round += 1) {
    await Promise.all([run(`web${round}`, 'churn'), run(`headless${round}`, 'churn'), run(`cli${round}`, 'save')])
    const files = readdirSync(dir).filter((entry) => entry.endsWith('.md') && entry !== 'MEMORY.md').map((entry) => entry.slice(0, -3)).sort()
    assert.deepEqual(indexOrder((await projectIndex(dir)).text).sort(), files, `round ${round}: the reader lists exactly the entry files`)
    await syncIndex(dir)
    assert.deepEqual(indexOrder(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).sort(), files, `round ${round}: after a read the file does too`)
    assert.equal(files.length, (round + 1) * (10 + 10 + 20))
  }
  assert.deepEqual(readdirSync(dir).filter((entry) => entry.startsWith('.')), [], 'no temp files are left behind')
})

/**
 * The state table the three store contracts are judged by: every cache state
 * crossed with every entry state, asserting only that readable entries are
 * shown, that a save and a delete commit, and that nothing hangs. Each cell
 * builds a fresh directory.
 */
test('state table: whatever the cache is, readable entries are shown and writes commit without hanging', async (t) => {
  const { chmodSync, mkdirSync: mkdir, symlinkSync } = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const root = typeof process.getuid === 'function' && process.getuid() === 0
  const mkfifo = (path) => new Promise((resolve) => execFile('mkfifo', [path], (error) => resolve(error === null)))
  const caches = {
    ok: async (dir) => { await syncIndex(dir) },
    missing: async (dir) => { rmSync(join(dir, 'MEMORY.md'), { force: true }) },
    stale: async (dir) => { writeFileSync(join(dir, 'MEMORY.md'), '# Title\n- [Ghost](ghost.md) — no such file\n') },
    unreadable: async (dir) => { writeFileSync(join(dir, 'MEMORY.md'), '- [x](x.md) — x\n'); chmodSync(join(dir, 'MEMORY.md'), 0o000) },
    directory: async (dir) => { rmSync(join(dir, 'MEMORY.md'), { force: true }); mkdir(join(dir, 'MEMORY.md')) },
    fifo: async (dir) => { rmSync(join(dir, 'MEMORY.md'), { force: true }); return mkfifo(join(dir, 'MEMORY.md')) },
    'symlink-loop': async (dir) => { rmSync(join(dir, 'MEMORY.md'), { force: true }); symlinkSync(join(dir, 'MEMORY.md'), join(dir, 'MEMORY.md')) },
  }
  const entries = {
    ok: async (dir) => { await saveMemory(dir, { name: 'fact', description: 'd', type: 'project', title: 'Fact', hook: 'the fact', content: 'c', sessionId: 's' }); return '- [Fact](fact.md) — the fact' },
    skipped: async (dir) => {
      await saveMemory(dir, { name: 'fact', description: 'd', type: 'project', title: 'Fact', hook: 'the fact', content: 'c', sessionId: 's' })
      await saveMemory(dir, { name: 'locked', description: 'd', type: 'project', title: 'Locked', hook: 'kept from the cache', content: 'c', sessionId: 's' })
      chmodSync(join(dir, 'locked.md'), 0o000)
      return '- [Fact](fact.md) — the fact'
    },
    legacy: async (dir) => { writeFileSync(join(dir, 'fact.md'), '---\nname: fact\ndescription: legacy description\n---\n\nbody\n'); return '- [fact](fact.md) — legacy description' },
    'space-name': async (dir) => {
      await saveMemory(dir, { name: 'fact', description: 'd', type: 'project', title: 'Fact', hook: 'the fact', content: 'c', sessionId: 's' })
      writeFileSync(join(dir, 'My Note.md'), '---\nname: My Note\ndescription: outside the grammar\n---\n\nbody\n')
      return '- [Fact](fact.md) — the fact'
    },
  }
  for (const [cacheState, makeCache] of Object.entries(caches)) {
    for (const [entryState, makeEntries] of Object.entries(entries)) {
      const cell = `${cacheState} × ${entryState}`
      if (root && (cacheState === 'unreadable' || entryState === 'skipped')) continue
      const dir = join(scratch(), 'store')
      mkdir(dir, { recursive: true })
      const expectedLine = await makeEntries(dir)
      const cachedLine = cacheState === 'ok' && entryState === 'skipped' ? '- [Locked](locked.md) — kept from the cache' : undefined
      const made = await makeCache(dir)
      if (made === false) continue
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${cell}: hung`)), 5000).unref())
      try {
        const shown = await Promise.race([projectIndex(dir), timeout])
        assert.ok(shown.text.includes(`${expectedLine}\n`), `${cell}: the readable entry is shown\n${shown.text}`)
        if (cachedLine !== undefined) assert.ok(shown.text.includes(cachedLine), `${cell}: the unreadable entry keeps its cached line`)
        assert.ok(!shown.text.includes('Ghost') && !shown.text.includes('# Title'), `${cell}: stale lines are gone`)
        if (entryState === 'space-name') assert.deepEqual(shown.skipped.map((entry) => [entry.name, entry.reason]), [['My Note', 'name']], `${cell}: the name outside the grammar is reported`)
        if (['unreadable', 'directory', 'fifo', 'symlink-loop'].includes(cacheState)) assert.ok(shown.cacheError !== undefined, `${cell}: the unusable cache is reported`)
        const saved = await Promise.race([saveMemory(dir, { name: 'added', description: 'd', type: 'user', title: 'Added', hook: 'added later', content: 'c', sessionId: 's' }), timeout])
        assert.ok(existsSync(join(dir, 'added.md')), `${cell}: the save commits`)
        if (cacheState === 'directory') assert.ok(saved.indexError !== undefined, `${cell}: a cache that cannot be replaced is reported beside the committed save`)
        const removed = await Promise.race([deleteMemory(dir, 'added'), timeout])
        assert.equal(removed.removedFile, true, `${cell}: the delete commits`)
        assert.ok(!existsSync(join(dir, 'added.md')))
        const after = await Promise.race([projectIndex(dir), timeout])
        assert.ok(after.text.includes(`${expectedLine}\n`) && !after.text.includes('added.md'), `${cell}: the projection follows the entry files`)
      } finally {
        // Restore the modes the cell took away, so the scratch directory can be removed; a cell that made no such file has nothing to restore.
        for (const file of ['MEMORY.md', 'locked.md']) if (existsSync(join(dir, file))) chmodSync(join(dir, file), 0o644)
      }
    }
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
  assert.deepEqual((await listEntries(dir)).entries.map((entry) => entry.name), ['alpha', 'beta'])
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
  const badDelete = await call(ctx, DELETE_TOOL_NAME, { name: '../two' }, agent)
  assert.equal(badDelete.isError, true)
  assert.match(text(badDelete), /file stem/)
  writeFileSync(join(dir, 'Copied_Entry.md'), '---\nname: Copied_Entry\ndescription: by hand\n---\n\nbody\n')
  const copied = await call(ctx, DELETE_TOOL_NAME, { name: 'Copied_Entry' }, agent)
  assert.equal(copied.isError, false, 'a hand-written entry outside the kebab-case grammar is still deletable')
  assert.equal(copied.value.existed, true)
  assert.equal(existsSync(join(dir, 'Copied_Entry.md')), false)
  const badType = await call(ctx, SAVE_TOOL_NAME, { name: 'ok', type: 'misc', title: 't', description: 'd', hook: 'h', content: 'c' }, agent)
  assert.equal(badType.isError, true, 'the registry enforces the type enum')
  const noAgent = await call(ctx, SAVE_TOOL_NAME, { name: 'ok', type: 'user', title: 't', description: 'd', hook: 'h', content: 'c' })
  assert.equal(noAgent.isError, true)
  assert.match(text(noAgent), /working directory/)

  const removed = await call(ctx, DELETE_TOOL_NAME, { name: 'deploy-host' }, agent)
  assert.equal(removed.isError, false)
  assert.deepEqual(removed.value, { path: join(dir, 'deploy-host.md'), existed: true, indexLines: 3, indexNote: '' })
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
