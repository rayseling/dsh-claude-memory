import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeCompletePrefix, locateMemoryIndex, mainRootOfWorktree, projectRoots, readIndex,
  renderIndexMessage, renderWithdrawnMessage, slugOf, truncateIndex,
} from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-')))
const limits = { maxLines: 200, maxChars: 25_000 }

const seedIndex = (claudeHome, root, text = '- [a](a.md) — hook\n') => {
  const dir = join(claudeHome, 'projects', slugOf(root), 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), text)
  return join(dir, 'MEMORY.md')
}

test('slugOf replaces every non-alphanumeric character, including dots', () => {
  assert.equal(slugOf('/Volumes/4Macmini/Code/deepseek-harness'), '-Volumes-4Macmini-Code-deepseek-harness')
  assert.equal(slugOf('/Users/me/.openclaw/workspace'), '-Users-me--openclaw-workspace')
})

test('projectRoots outside git is the directory itself', async () => {
  const dir = scratch()
  assert.deepEqual(await projectRoots(dir), [dir])
})

test('projectRoots inside a repository puts the repository root before the subdirectory', async () => {
  const repo = scratch()
  mkdirSync(join(repo, '.git'))
  const sub = join(repo, 'packages', 'x')
  mkdirSync(sub, { recursive: true })
  assert.deepEqual(await projectRoots(sub), [repo, sub])
  assert.deepEqual(await projectRoots(repo), [repo])
})

test('projectRoots in a linked worktree adds the main repository after the worktree', async () => {
  const main = scratch()
  mkdirSync(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
  const wt = join(main, '.claude', 'worktrees', 'feat')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  assert.deepEqual(await projectRoots(wt), [wt, main])
  assert.equal(await mainRootOfWorktree(join(wt, '.git')), main)
})

test('mainRootOfWorktree rejects a .git file that names no worktree gitdir', async () => {
  const dir = scratch()
  writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git\n')
  assert.equal(await mainRootOfWorktree(join(dir, '.git')), undefined)
  writeFileSync(join(dir, '.git'), 'not a pointer\n')
  assert.equal(await mainRootOfWorktree(join(dir, '.git')), undefined)
})

test('locateMemoryIndex prefers the repository root, falls back to the main repository, and reports size and mtime', async () => {
  const home = scratch()
  const main = scratch()
  mkdirSync(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
  const wt = join(main, '.claude', 'worktrees', 'feat')
  mkdirSync(join(wt, 'deep'), { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  assert.equal(await locateMemoryIndex(join(wt, 'deep'), home), undefined)
  const mainIndex = seedIndex(home, main)
  const found = await locateMemoryIndex(join(wt, 'deep'), home)
  assert.equal(found.root, main)
  assert.equal(found.path, mainIndex)
  assert.equal(found.size, Buffer.byteLength('- [a](a.md) — hook\n'))
  assert.equal(typeof found.mtimeMs, 'number')
  const wtIndex = seedIndex(home, wt)
  assert.equal((await locateMemoryIndex(join(wt, 'deep'), home)).path, wtIndex)
})

test('locateMemoryIndex ignores a MEMORY.md that is a directory', async () => {
  const home = scratch()
  const dir = scratch()
  mkdirSync(join(home, 'projects', slugOf(dir), 'memory', 'MEMORY.md'), { recursive: true })
  assert.equal(await locateMemoryIndex(dir, home), undefined)
})

test('truncateIndex keeps whole text under both caps', () => {
  assert.deepEqual(truncateIndex('a\nb\nc\n', limits), { text: 'a\nb\nc\n', truncated: false })
})

test('truncateIndex caps lines first', () => {
  const text = Array.from({ length: 300 }, (_, index) => `line ${index}`).join('\n')
  const result = truncateIndex(text, limits)
  assert.equal(result.text.split('\n').length, 200)
  assert.equal(result.truncated, true)
})

test('truncateIndex counts UTF-16 code units and cuts back to a line end', () => {
  const line = '中文记忆条目'.repeat(4) // 24 code units, 72 bytes
  const text = Array.from({ length: 10 }, () => line).join('\n')
  const result = truncateIndex(text, { maxLines: 200, maxChars: 100 })
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 100)
  for (const kept of result.text.split('\n')) assert.equal(kept, line)
  assert.equal(result.text.split('\n').length, 4)
})

test('truncateIndex on a single over-long line keeps a prefix and never splits a surrogate pair', () => {
  const emoji = '😀'.repeat(50) // 100 code units
  const result = truncateIndex(emoji, { maxLines: 200, maxChars: 7 })
  assert.equal(result.truncated, true)
  assert.equal(result.text, '😀😀😀')
  const plain = truncateIndex('中文记忆'.repeat(30), { maxLines: 200, maxChars: 10 })
  assert.equal(plain.text, '中文记忆中文记忆中文')
  assert.ok(!plain.text.includes('�'))
})

test('decodeCompletePrefix drops an unfinished trailing sequence only', () => {
  const bytes = Buffer.from('中文', 'utf8')
  assert.equal(decodeCompletePrefix(bytes), '中文')
  assert.equal(decodeCompletePrefix(bytes.subarray(0, 5)), '中')
  assert.equal(decodeCompletePrefix(bytes.subarray(0, 4)), '中')
  assert.equal(decodeCompletePrefix(Buffer.alloc(0)), '')
})

test('locateMemoryIndex throws on a stat failure that is not absence', async () => {
  const home = scratch()
  const project = scratch()
  const dir = join(home, 'projects', slugOf(project), 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '- a\n')
  const { chmodSync, statSync } = await import('node:fs')
  chmodSync(dir, 0o000)
  let inspectable = true
  try { statSync(join(dir, 'MEMORY.md')) } catch { inspectable = false }
  try {
    if (!inspectable) await assert.rejects(locateMemoryIndex(project, home), { code: 'EACCES' })
  } finally {
    chmodSync(dir, 0o755)
  }
})

test('readIndex reads a bounded window and marks a continuing file as truncated', async () => {
  const dir = scratch()
  const small = join(dir, 'small.md')
  writeFileSync(small, '- one\n- two\n')
  assert.deepEqual(await readIndex(small, limits), { text: '- one\n- two\n', truncated: false })
  const big = join(dir, 'big.md')
  writeFileSync(big, Array.from({ length: 50 }, (_, index) => `- 条目${index} 中文内容`).join('\n') + '\n')
  const result = await readIndex(big, { maxLines: 200, maxChars: 40 })
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 40)
  assert.ok(!result.text.includes('�'))
  for (const line of result.text.split('\n')) assert.match(line, /^- 条目\d+ 中文内容$/)
})

test('renderIndexMessage frames the path, the directory rule, and a truncation note', () => {
  const full = renderIndexMessage({ path: '/h/.claude/projects/-p/memory/MEMORY.md', text: '- [x](x.md) — y\n', truncated: false })
  assert.ok(full.startsWith('<system-reminder>\nContents of /h/.claude/projects/-p/memory/MEMORY.md'))
  assert.ok(full.includes('memory file in /h/.claude/projects/-p/memory.'))
  assert.ok(full.endsWith('- [x](x.md) — y\n</system-reminder>'))
  assert.ok(!full.includes('Only the beginning'))
  assert.ok(renderIndexMessage({ path: '/m/MEMORY.md', text: 'a', truncated: true }).includes('Only the beginning of the index'))
  assert.ok(renderWithdrawnMessage('/m/MEMORY.md').includes('(/m/MEMORY.md) is no longer available'))
})
