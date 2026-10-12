import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateMemoryIndex, mainRootOfWorktree, projectRoots, renderIndexMessage, slugOf, truncateIndex } from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-')))

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

test('projectRoots outside git is the directory itself', () => {
  const dir = scratch()
  assert.deepEqual(projectRoots(dir), [dir])
})

test('projectRoots inside a repository puts the repository root before the subdirectory', () => {
  const repo = scratch()
  mkdirSync(join(repo, '.git'))
  const sub = join(repo, 'packages', 'x')
  mkdirSync(sub, { recursive: true })
  assert.deepEqual(projectRoots(sub), [repo, sub])
  assert.deepEqual(projectRoots(repo), [repo])
})

test('projectRoots in a linked worktree adds the main repository after the worktree', () => {
  const main = scratch()
  mkdirSync(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
  const wt = join(main, '.claude', 'worktrees', 'feat')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  assert.deepEqual(projectRoots(wt), [wt, main])
  assert.equal(mainRootOfWorktree(join(wt, '.git')), main)
})

test('mainRootOfWorktree rejects a .git file that names no worktree gitdir', () => {
  const dir = scratch()
  writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git\n')
  assert.equal(mainRootOfWorktree(join(dir, '.git')), undefined)
  writeFileSync(join(dir, '.git'), 'not a pointer\n')
  assert.equal(mainRootOfWorktree(join(dir, '.git')), undefined)
})

test('locateMemoryIndex prefers the repository root and falls back to the main repository of a worktree', () => {
  const home = scratch()
  const main = scratch()
  mkdirSync(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
  const wt = join(main, '.claude', 'worktrees', 'feat')
  mkdirSync(join(wt, 'deep'), { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  assert.equal(locateMemoryIndex(join(wt, 'deep'), home), undefined)
  const mainIndex = seedIndex(home, main)
  assert.deepEqual(locateMemoryIndex(join(wt, 'deep'), home), { root: main, path: mainIndex })
  const wtIndex = seedIndex(home, wt)
  assert.deepEqual(locateMemoryIndex(join(wt, 'deep'), home), { root: wt, path: wtIndex })
})

test('locateMemoryIndex ignores a MEMORY.md that is a directory', () => {
  const home = scratch()
  const dir = scratch()
  mkdirSync(join(home, 'projects', slugOf(dir), 'memory', 'MEMORY.md'), { recursive: true })
  assert.equal(locateMemoryIndex(dir, home), undefined)
})

test('truncateIndex keeps whole text under both caps', () => {
  const result = truncateIndex('a\nb\nc\n', { maxLines: 200, maxBytes: 25 * 1024 })
  assert.deepEqual(result, { text: 'a\nb\nc\n', truncated: false, totalLines: 4 })
})

test('truncateIndex caps lines first', () => {
  const text = Array.from({ length: 300 }, (_, index) => `line ${index}`).join('\n')
  const result = truncateIndex(text, { maxLines: 200, maxBytes: 25 * 1024 })
  assert.equal(result.text.split('\n').length, 200)
  assert.equal(result.truncated, true)
  assert.equal(result.totalLines, 300)
})

test('truncateIndex caps bytes on a whole line and never splits a multibyte character', () => {
  const line = '中文记忆条目'.repeat(4) // 24 chars × 3 bytes = 72 bytes
  const text = Array.from({ length: 10 }, () => line).join('\n')
  const result = truncateIndex(text, { maxLines: 200, maxBytes: 200 })
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 200)
  assert.ok(!result.text.includes('�'))
  for (const kept of result.text.split('\n')) assert.equal(kept, line)
})

test('renderIndexMessage frames the path, the directory rule, and a truncation note', () => {
  const full = renderIndexMessage({ path: '/h/.claude/projects/-p/memory/MEMORY.md', text: '- [x](x.md) — y\n', truncated: false, totalLines: 1 })
  assert.ok(full.startsWith('<system-reminder>\nContents of /h/.claude/projects/-p/memory/MEMORY.md'))
  assert.ok(full.includes('memory file in /h/.claude/projects/-p/memory.'))
  assert.ok(full.endsWith('- [x](x.md) — y\n</system-reminder>'))
  assert.ok(!full.includes('Only the first part'))
  const cut = renderIndexMessage({ path: '/m/MEMORY.md', text: 'a', truncated: true, totalLines: 400 })
  assert.ok(cut.includes('the file has 400 lines'))
})
