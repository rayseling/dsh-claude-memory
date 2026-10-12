/**
 * Pure helpers: where Claude Code keeps a project's memory, and how its index
 * is bounded and framed for the model. Nothing here touches the harness, so
 * `node --test` covers it without a profile.
 *
 * Claude Code stores auto memory under `<claudeHome>/projects/<slug>/memory/`,
 * where `<slug>` is the project path with every character outside
 * `[A-Za-z0-9]` replaced by `-`. The project is the git repository root when
 * there is one, else the working directory. The index `MEMORY.md` is loaded
 * up to its first 200 lines or 25 KB, whichever comes first; topic files are
 * read on demand.
 * @module dsh-claude-memory/locate
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Claude Code's project directory name for one absolute path.
 * @param {string} path - absolute project path.
 * @returns {string} the path with every non-alphanumeric character replaced by `-`.
 */
export function slugOf(path) {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * @param {string} path
 * @returns {import('node:fs').Stats | undefined} stats, or undefined when the path is absent or unreadable.
 */
function statOrUndefined(path) {
  try {
    return statSync(path)
  } catch {
    // ENOENT, ENOTDIR, EACCES all mean "not a usable entry" here.
    return undefined
  }
}

/**
 * Nearest ancestor of `start` (inclusive) holding a `.git` entry.
 * @param {string} start - absolute directory to walk up from.
 * @returns {{ root: string, isFile: boolean, path: string } | undefined} the repository
 *   root, whether `.git` is a file (linked worktree) or a directory, and the entry path.
 */
export function findGitEntry(start) {
  let dir = resolve(start)
  for (;;) {
    const candidate = join(dir, '.git')
    const info = statOrUndefined(candidate)
    if (info !== undefined) return { root: dir, isFile: info.isFile(), path: candidate }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Main repository root recorded by a linked worktree's `.git` file.
 * @param {string} gitFile - path of the `.git` file (`gitdir: <main>/.git/worktrees/<name>`).
 * @returns {string | undefined} `<main>`, or undefined when the file does not name a worktree gitdir.
 */
export function mainRootOfWorktree(gitFile) {
  let text
  try {
    text = readFileSync(gitFile, 'utf8')
  } catch {
    // An unreadable `.git` file yields no main root; the worktree path itself still applies.
    return undefined
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text)
  if (match === null) return undefined
  const raw = match[1].trim()
  const gitdir = isAbsolute(raw) ? raw : resolve(dirname(gitFile), raw)
  const marker = `${sep}.git${sep}worktrees${sep}`
  const index = gitdir.lastIndexOf(marker)
  return index === -1 ? undefined : gitdir.slice(0, index)
}

/**
 * Project roots whose Claude Code memory may belong to `cwd`, most specific
 * first: the enclosing repository (a linked worktree's own path first, then
 * its main repository), then `cwd` itself for directories outside git.
 * @param {string} cwd - absolute session working directory.
 * @returns {string[]} distinct absolute candidates in lookup order.
 */
export function projectRoots(cwd) {
  const roots = []
  const git = findGitEntry(cwd)
  if (git !== undefined) {
    roots.push(git.root)
    if (git.isFile) {
      const main = mainRootOfWorktree(git.path)
      if (main !== undefined) roots.push(main)
    }
  }
  roots.push(resolve(cwd))
  return [...new Set(roots)]
}

/**
 * Locate the Claude Code memory index that applies to a working directory.
 * @param {string} cwd - absolute session working directory.
 * @param {string} claudeHome - Claude Code configuration directory (normally `~/.claude`).
 * @returns {{ root: string, path: string } | undefined} the matched project root and the
 *   `MEMORY.md` path, or undefined when no candidate has one.
 */
export function locateMemoryIndex(cwd, claudeHome) {
  for (const root of projectRoots(cwd)) {
    const path = join(claudeHome, 'projects', slugOf(root), 'memory', 'MEMORY.md')
    if (statOrUndefined(path)?.isFile()) return { root, path }
  }
  return undefined
}

/**
 * Bound the index the way Claude Code does: the first `maxLines` lines or the
 * first `maxBytes` bytes, whichever comes first, cut back to a whole line.
 * @param {string} text - full `MEMORY.md` content.
 * @param {{ maxLines: number, maxBytes: number }} limits - positive integer caps.
 * @returns {{ text: string, truncated: boolean, totalLines: number }} the bounded text.
 */
export function truncateIndex(text, { maxLines, maxBytes }) {
  const lines = text.split('\n')
  const kept = lines.length > maxLines ? lines.slice(0, maxLines) : lines
  let out = kept.join('\n')
  let truncated = kept.length < lines.length
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = Buffer.from(out, 'utf8').subarray(0, maxBytes).toString('utf8')
    const newline = out.lastIndexOf('\n')
    if (newline > 0) out = out.slice(0, newline)
    truncated = true
  }
  return { text: out, truncated, totalLines: lines.length }
}

/**
 * Frame the bounded index as the model-facing message.
 * @param {{ path: string, text: string, truncated: boolean, totalLines: number }} index - located and bounded index.
 * @returns {string} the complete `<system-reminder>` block.
 */
export function renderIndexMessage({ path, text, truncated, totalLines }) {
  const dir = dirname(path)
  const note = truncated
    ? ` Only the first part of the index is shown; the file has ${totalLines} lines, read it directly for the rest.`
    : ''
  return [
    '<system-reminder>',
    `Contents of ${path} (Claude Code's persistent memory index for this project; dsh-claude-memory loads it at the start of each conversation). Each line names one memory file in ${dir}. Read a memory file with a shell \`cat\` only when the current task relates to it; never read them all at once. Claude Code maintains these files: do not create, edit, or delete them, and do not copy their contents into the repository.${note}`,
    '',
    text.trimEnd(),
    '</system-reminder>',
  ].join('\n')
}
