/**
 * Pure helpers: where Claude Code keeps a project's memory, how its index is
 * read within bounds, and how it is framed for the model. Nothing here
 * touches the harness, so `node --test` covers it without a profile.
 *
 * Claude Code stores auto memory under `<claudeHome>/projects/<slug>/memory/`,
 * where `<slug>` is the project path with every character outside
 * `[A-Za-z0-9]` replaced by `-`. The project is the git repository root when
 * there is one, else the working directory. The index `MEMORY.md` is loaded
 * up to its first 200 lines or 25,000 UTF-16 code units (the documentation
 * says "25KB"; anthropics/claude-code#97453 measured code units), whichever
 * comes first, cut at a line end. Topic files are read on demand.
 * @module dsh-claude-memory/locate
 */

import { open, readFile, stat } from 'node:fs/promises'
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
 * @returns {Promise<import('node:fs').Stats | undefined>} stats, or undefined when the path is absent or unreadable.
 */
async function statOrUndefined(path) {
  try {
    return await stat(path)
  } catch {
    // ENOENT, ENOTDIR, EACCES all mean "not a usable entry" here.
    return undefined
  }
}

/**
 * Nearest ancestor of `start` (inclusive) holding a `.git` entry.
 * @param {string} start - absolute directory to walk up from.
 * @returns {Promise<{ root: string, isFile: boolean, path: string } | undefined>} the
 *   repository root, whether `.git` is a file (linked worktree) or a directory, and the entry path.
 */
export async function findGitEntry(start) {
  let dir = resolve(start)
  for (;;) {
    const candidate = join(dir, '.git')
    const info = await statOrUndefined(candidate)
    if (info !== undefined) return { root: dir, isFile: info.isFile(), path: candidate }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Main repository root recorded by a linked worktree's `.git` file.
 * @param {string} gitFile - path of the `.git` file (`gitdir: <main>/.git/worktrees/<name>`).
 * @returns {Promise<string | undefined>} `<main>`, or undefined when the file does not name a worktree gitdir.
 */
export async function mainRootOfWorktree(gitFile) {
  let text
  try {
    text = await readFile(gitFile, 'utf8')
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
 * @returns {Promise<string[]>} distinct absolute candidates in lookup order.
 */
export async function projectRoots(cwd) {
  const roots = []
  const git = await findGitEntry(cwd)
  if (git !== undefined) {
    roots.push(git.root)
    if (git.isFile) {
      const main = await mainRootOfWorktree(git.path)
      if (main !== undefined) roots.push(main)
    }
  }
  roots.push(resolve(cwd))
  return [...new Set(roots)]
}

/**
 * Locate the Claude Code memory index that applies to a working directory.
 * Absence (`ENOENT`, `ENOTDIR`) is a result; any other stat failure is thrown,
 * because a file that exists but cannot be inspected is not a file that is gone.
 * @param {string} cwd - absolute session working directory.
 * @param {string} claudeHome - Claude Code configuration directory (normally `~/.claude`).
 * @returns {Promise<{ root: string, path: string, size: number, mtimeMs: number } | undefined>} the
 *   matched project root, the `MEMORY.md` path and its current size and mtime, or undefined when no candidate has one.
 */
export async function locateMemoryIndex(cwd, claudeHome) {
  for (const root of await projectRoots(cwd)) {
    const path = join(claudeHome, 'projects', slugOf(root), 'memory', 'MEMORY.md')
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      throw error
    }
    if (info.isFile()) return { root, path, size: info.size, mtimeMs: info.mtimeMs }
  }
  return undefined
}

/**
 * Decode the longest prefix of `buffer` that is complete UTF-8, dropping at
 * most the three bytes of one unfinished trailing sequence.
 * @param {Buffer} buffer - bytes read from the file.
 * @returns {string} the decoded prefix.
 */
export function decodeCompletePrefix(buffer) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = buffer.length; end >= 0 && end >= buffer.length - 3; end -= 1) {
    try {
      return decoder.decode(buffer.subarray(0, end))
    } catch {
      // The tail splits a multibyte sequence; drop one more byte.
    }
  }
  return new TextDecoder('utf-8').decode(buffer)
}

/**
 * Bound an index the way Claude Code does: the first `maxLines` lines or the
 * first `maxChars` UTF-16 code units, whichever comes first. A cut lands on
 * the last line end before the limit when there is one; otherwise the first
 * line's longest prefix that does not split a surrogate pair.
 * @param {string} text - index content, possibly already a prefix of the file.
 * @param {{ maxLines: number, maxChars: number }} limits - positive integer caps.
 * @returns {{ text: string, truncated: boolean }} the bounded text and whether anything was cut.
 */
export function truncateIndex(text, { maxLines, maxChars }) {
  const lines = text.split('\n')
  const kept = lines.length > maxLines ? lines.slice(0, maxLines) : lines
  let out = kept.join('\n')
  let truncated = kept.length < lines.length
  if (out.length > maxChars) {
    out = out.slice(0, maxChars)
    const newline = out.lastIndexOf('\n')
    if (newline > 0) {
      out = out.slice(0, newline)
    } else {
      const last = out.charCodeAt(out.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
    }
    truncated = true
  }
  return { text: out, truncated }
}

/**
 * Read a bounded prefix of the index and apply {@link truncateIndex}. At most
 * `3 * maxChars + 1` bytes leave the disk, which is enough to decide every
 * code-unit cut (a code unit never needs more than three UTF-8 bytes).
 * @param {string} path - `MEMORY.md` path.
 * @param {{ maxLines: number, maxChars: number }} limits - positive integer caps.
 * @returns {Promise<{ text: string, truncated: boolean }>} the bounded text; `truncated` is also true when the file continued past the read window.
 */
export async function readIndex(path, limits) {
  const budget = 3 * limits.maxChars + 1
  const handle = await open(path, 'r')
  let buffer = Buffer.alloc(budget)
  try {
    // A read may return fewer bytes than asked without reaching the end.
    let filled = 0
    while (filled < budget) {
      const { bytesRead } = await handle.read(buffer, filled, budget - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    buffer = buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }
  const partial = buffer.length === budget
  const decoded = partial ? decodeCompletePrefix(buffer) : buffer.toString('utf8')
  const bounded = truncateIndex(decoded, limits)
  // A window that stops mid-file cannot vouch for its last line.
  if (partial && !bounded.truncated) {
    const newline = bounded.text.lastIndexOf('\n')
    return { text: newline > 0 ? bounded.text.slice(0, newline) : bounded.text, truncated: true }
  }
  return bounded
}

/**
 * Frame the bounded index as the model-facing message.
 * @param {{ path: string, text: string, truncated: boolean }} index - located and bounded index.
 * @returns {string} the complete `<system-reminder>` block.
 */
export function renderIndexMessage({ path, text, truncated }) {
  const dir = dirname(path)
  const note = truncated
    ? ' Only the beginning of the index is shown; read the file directly for the rest.'
    : ''
  return [
    '<system-reminder>',
    `Contents of ${path} (Claude Code's persistent memory index for this project; dsh-claude-memory loads it at the start of each conversation). Each line names one memory file in ${dir}. Read a memory file with a shell \`cat\` only when the current task relates to it; never read them all at once. Claude Code maintains these files: do not create, edit, or delete them, and do not copy their contents into the repository.${note}`,
    '',
    text.trimEnd(),
    '</system-reminder>',
  ].join('\n')
}

/**
 * Frame the withdrawal that replaces an index the model has seen after the
 * file disappeared or became blank.
 * @param {string} path - the `MEMORY.md` path shown earlier.
 * @returns {string} the complete `<system-reminder>` block.
 */
export function renderWithdrawnMessage(path) {
  return [
    '<system-reminder>',
    `The Claude Code memory index shown earlier for this project (${path}) is no longer available: the file is missing or empty. Treat that earlier index as withdrawn and do not rely on it.`,
    '</system-reminder>',
  ].join('\n')
}
