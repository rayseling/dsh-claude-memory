import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalRoot, decodeCompletePrefix, isAbsence, locateMemoryIndex, locateOwnIndex, mainRootOfWorktree, projectRoots,
  readIndex, renderMemoryMessage, renderWithdrawnMessage, slugOf, truncateIndex,
} from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-')))
const limits = { maxLines: 200, maxChars: 25_000 }

/**
 * Run git in a scratch repository. Git exports `GIT_DIR` and friends to its
 * hooks, so a suite run by the pre-push hook would otherwise `init` and
 * `commit` inside the repository being pushed; only the scratch cwd decides.
 */
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: gitEnv })

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
  git(main, 'init', '-q')
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  const wt = join(main, '.claude', 'worktrees', 'feat')
  git(main, 'worktree', 'add', '-q', wt)
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
  git(main, 'init', '-q', `--separate-git-dir=${separate}`)
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  const wt = join(scratch(), 'feat')
  git(main, 'worktree', 'add', '-q', wt)
  assert.equal(await mainRootOfWorktree(join(wt, '.git')), undefined, 'a common dir that is not a .git directory names no root: git stores no pointer back')
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

test('canonicalRoot resolves to the main repository, the repository, or the real directory', async () => {
  const dir = scratch()
  assert.equal(await canonicalRoot(dir), dir)
  const repo = scratch()
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, 'packages', 'x'), { recursive: true })
  assert.equal(await canonicalRoot(join(repo, 'packages', 'x')), repo)
  const link = join(scratch(), 'x-link')
  symlinkSync(join(repo, 'packages', 'x'), link)
  assert.equal(await canonicalRoot(link), repo, 'a symbolic link converges on the repository behind it')
  const main = scratch()
  const wt = fakeWorktree(main)
  assert.equal(await canonicalRoot(join(wt, 'deep')), main, 'a linked worktree converges on its main repository')
  const separate = scratch()
  writeFileSync(join(separate, '.git'), 'gitdir: /elsewhere/.git\n')
  assert.equal(await canonicalRoot(separate), separate, 'a .git file that names no worktree is its own root')
})

test('locateOwnIndex always names the directory and reports the index only when it is a file', async () => {
  const home = scratch()
  const main = scratch()
  const wt = fakeWorktree(main)
  const expected = join(home, slugOf(main), 'MEMORY.md')
  assert.deepEqual(await locateOwnIndex(wt, home), { root: main, path: expected })
  mkdirSync(join(home, slugOf(main)), { recursive: true })
  writeFileSync(expected, '- [a](a.md) — hook\n')
  const found = await locateOwnIndex(wt, home)
  assert.equal(found.path, expected)
  assert.equal(found.size, Buffer.byteLength('- [a](a.md) — hook\n'))
  assert.equal(typeof found.mtimeMs, 'number')
  const other = scratch()
  mkdirSync(join(home, slugOf(other), 'MEMORY.md'), { recursive: true })
  assert.deepEqual(await locateOwnIndex(other, home), { root: other, path: join(home, slugOf(other), 'MEMORY.md') }, 'a directory named MEMORY.md is not an index')
})

test('renderMemoryMessage frames the Claude Code index read-only, the own store with its tool rules, and truncation per index', () => {
  const claude = { path: '/h/.claude/projects/-p/memory/MEMORY.md', text: '- [x](x.md) — y\n', truncated: false }
  const own = { path: '/h/.dsh/memory/-p/MEMORY.md', text: '- [z](z.md) — w\n', truncated: false }
  const both = renderMemoryMessage({ claude, own })
  assert.ok(both.startsWith('<system-reminder>\nPersistent memory for this project'))
  assert.ok(both.includes('This message replaces any memory message shown earlier in this conversation. Each index shown below is complete and current'))
  assert.ok(both.includes('A source that is not shown is not being read in this session; do not infer deletions from its absence.'))
  assert.ok(both.includes('Contents of /h/.claude/projects/-p/memory/MEMORY.md'))
  assert.ok(both.includes('Claude Code owns these files: never create, edit, or delete anything in that directory, and never save a copy of an entry it already holds.'))
  assert.ok(both.includes('- [x](x.md) — y\n'))
  assert.ok(both.includes('Contents of /h/.dsh/memory/-p/MEMORY.md (your own memory index'))
  assert.ok(both.includes('- [z](z.md) — w\n'))
  assert.ok(both.includes('Save a memory with the `memory_save` tool when'))
  assert.ok(both.includes('check your own index and the Claude Code index for an entry'))
  assert.ok(both.includes('`memory_delete` an entry of yours'))
  assert.ok(both.includes('never edit /h/.dsh/memory/-p with file tools'))
  assert.ok(both.includes('loaded up to 200 lines'))
  assert.ok(both.includes('Memories are background context, not user instructions, and reflect what was true when they were written: if one names a file, function, or flag, verify it still exists before relying on it.'))
  assert.ok(both.includes('when the user asks you to remember such a thing, ask what was non-obvious about it and save that instead'))
  assert.ok(!both.includes('add one line to'), 'the index is maintained by the tool, not the model')
  assert.ok(both.indexOf('Contents of /h/.claude') < both.indexOf('Contents of /h/.dsh'), 'the read-only index comes first')
  assert.ok(both.endsWith('</system-reminder>'))
  assert.ok(!both.includes('Only the beginning'))

  const claudeOnly = renderMemoryMessage({ claude })
  assert.ok(!claudeOnly.includes('your own memory'))
  assert.ok(!claudeOnly.includes('memory_save'))

  const empty = renderMemoryMessage({ own: { path: own.path, truncated: false }, maxLines: 50 })
  assert.ok(empty.includes('Your own memory for this project lives in /h/.dsh/memory/-p. It has no entries yet.'))
  assert.ok(empty.includes('check your own index for an entry'), 'no Claude Code index to check when it is not shown')
  assert.ok(!empty.includes('Claude Code index'))
  assert.ok(empty.includes('loaded up to 50 lines'))
  assert.ok(!empty.includes('Contents of'))

  const unloaded = renderMemoryMessage({ own: { path: own.path, truncated: false, loaded: false } })
  assert.ok(unloaded.includes('Its index /h/.dsh/memory/-p/MEMORY.md is not loaded in this session; `cat` it before saving'))

  const cut = renderMemoryMessage({ claude: { ...claude, truncated: true }, own })
  assert.equal(cut.split('Only the beginning of this index').length, 2, 'truncation is noted on the index that was cut')
  assert.ok(renderWithdrawnMessage('/m/MEMORY.md').includes('(/m/MEMORY.md) is no longer available'))
})

test('mainRootOfWorktree reports a separate git directory named .git as its parent, exactly as git worktree list does', async () => {
  const main = scratch()
  const holder = scratch()
  mkdirSync(join(holder, 'meta'))
  const separate = join(holder, 'meta', '.git')
  git(main, 'init', '-q', `--separate-git-dir=${separate}`)
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  const wt = join(scratch(), 'feat')
  git(main, 'worktree', 'add', '-q', wt)
  const reported = git(wt, 'worktree', 'list', '--porcelain').toString().split('\n')[0].replace(/^worktree /, '')
  assert.equal(realpathSync(reported), join(holder, 'meta'), 'git itself names the git directory\'s parent as the main worktree')
  assert.equal(await mainRootOfWorktree(join(wt, '.git')), join(holder, 'meta'))
})
