import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeCompletePrefix, isAbsence, locateMemoryIndex, mainRootOfWorktree, projectRoots, readIndex,
  renderIndexMessage, renderWithdrawnMessage, slugOf, truncateIndex,
} from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-')))
const limits = { maxLines: 200, maxChars: 25_000 }

/** Lay out a main repository and one linked worktree the way git does (without running git). */
const fakeWorktree = (main, name = 'feat') => {
  const gitdir = join(main, '.git', 'worktrees', name)
  mkdirSync(gitdir, { recursive: true })
  writeFileSync(join(gitdir, 'commondir'), '../..\n')
  const wt = join(main, '.claude', 'worktrees', name)
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
  return wt
}

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
  const wt = fakeWorktree(main)
  assert.deepEqual(await projectRoots(wt), [wt, main])
  assert.equal(await mainRootOfWorktree(join(wt, '.git')), main)
})

test('projectRoots agrees with a worktree git itself created', async () => {
  const main = scratch()
  const git = (...args) => execFileSync('git', args, { cwd: main, stdio: 'pipe' })
  git('init', '-q')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  const wt = join(main, '.claude', 'worktrees', 'feat')
  git('worktree', 'add', '-q', wt)
  assert.deepEqual(await projectRoots(join(wt, 'sub')), [wt, main, join(wt, 'sub')])
})

test('mainRootOfWorktree gives up where git stores the main repository elsewhere', async () => {
  const dir = scratch()
  writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git\n')
  assert.equal(await mainRootOfWorktree(join(dir, '.git')), undefined, 'gitdir without commondir is a separate git dir, not a worktree')
  writeFileSync(join(dir, '.git'), 'not a pointer\n')
  assert.equal(await mainRootOfWorktree(join(dir, '.git')), undefined)
  const main = scratch()
  const separate = join(scratch(), 'meta')
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git(main, 'init', '-q', `--separate-git-dir=${separate}`)
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  const wt = join(scratch(), 'feat')
  git(main, 'worktree', 'add', '-q', wt)
  assert.equal(await mainRootOfWorktree(join(wt, '.git')), undefined, 'a common dir that is not a .git directory names no root')
  assert.deepEqual(await projectRoots(wt), [wt], 'the worktree itself still applies')
  assert.deepEqual(await projectRoots(main), [main], 'the separate-git-dir main repository is found by its .git file')
})

test('projectRoots passes on a .git file that cannot be read instead of dropping the main repository', async () => {
  const main = scratch()
  const wt = fakeWorktree(main)
  const { chmodSync, readFileSync } = await import('node:fs')
  chmodSync(join(wt, '.git'), 0o000)
  let readable = true
  try { readFileSync(join(wt, '.git')) } catch { readable = false }
  try {
    if (!readable) await assert.rejects(projectRoots(wt), { code: 'EACCES' })
  } finally {
    chmodSync(join(wt, '.git'), 0o644)
  }
})

test('projectRoots entered through a symbolic link finds the repository behind it and keeps the literal path', async () => {
  const repo = scratch()
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, 'packages', 'x'), { recursive: true })
  const link = join(scratch(), 'x-link')
  symlinkSync(join(repo, 'packages', 'x'), link)
  assert.deepEqual(await projectRoots(link), [link, repo, join(repo, 'packages', 'x')])
  const home = scratch()
  seedIndex(home, repo)
  assert.equal((await locateMemoryIndex(link, home)).root, repo)
})

test('isAbsence recognises only a missing path', () => {
  assert.equal(isAbsence({ code: 'ENOENT' }), true)
  assert.equal(isAbsence({ code: 'ENOTDIR' }), true)
  assert.equal(isAbsence({ code: 'EACCES' }), false)
  assert.equal(isAbsence(undefined), false)
})

test('locateMemoryIndex prefers the repository root, falls back to the main repository, and reports size and mtime', async () => {
  const home = scratch()
  const main = scratch()
  const wt = fakeWorktree(main)
  mkdirSync(join(wt, 'deep'))
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
  assert.ok(full.includes('replaces any memory index shown earlier in this conversation'))
  assert.ok(full.endsWith('- [x](x.md) — y\n</system-reminder>'))
  assert.ok(!full.includes('Only the beginning'))
  assert.ok(renderIndexMessage({ path: '/m/MEMORY.md', text: 'a', truncated: true }).includes('Only the beginning of the index'))
  assert.ok(renderWithdrawnMessage('/m/MEMORY.md').includes('(/m/MEMORY.md) is no longer available'))
})
