/**
 * Pure helpers: where a project's memory lives, how an index is read within
 * bounds, and how both stores are framed for the model. Nothing here touches
 * the harness, so `node --test` covers it without a profile.
 *
 * Claude Code stores auto memory under `<claudeHome>/projects/<slug>/memory/`,
 * where `<slug>` is the project path with every character outside
 * `[A-Za-z0-9]` replaced by `-`. The project is the git repository root when
 * there is one, else the working directory. The index `MEMORY.md` is loaded
 * up to its first 200 lines or 25,000 UTF-16 code units (the documentation
 * says "25KB"; anthropics/claude-code#97453 measured code units), whichever
 * comes first, cut at a line end. Topic files are read on demand.
 *
 * The harness's own store, which the model writes, uses the same layout under
 * `<ownMemoryHome>/<slug>/`. Its slug is taken from the project's canonical
 * root (see {@link canonicalRoot}) so every session of a repository, from any
 * worktree or symbolic link, reads and writes one directory.
 * @module dsh-claude-memory/locate
 */

import { open, readFile, realpath, stat } from 'node:fs/promises'
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
 * Whether a filesystem error means the path is simply not there. Every other
 * failure (EACCES, EIO, ELOOP, ...) says nothing about what exists and is
 * passed on, so a caller never mistakes "cannot look" for "absent".
 * @param {unknown} error - error thrown by `node:fs`.
 * @returns {boolean} true for `ENOENT` and `ENOTDIR`.
 */
export function isAbsence(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

/**
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats | undefined>} stats, or undefined when the path is absent.
 */
async function statOrAbsent(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (isAbsence(error)) return undefined
    throw error
  }
}

/**
 * @param {string} path
 * @returns {Promise<string | undefined>} file text, or undefined when the path is absent.
 */
async function readOrAbsent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsence(error)) return undefined
    throw error
  }
}

/**
 * Nearest ancestor of `start` (inclusive) holding a `.git` entry.
 * @param {string} start - absolute directory to walk up from.
 * @returns {Promise<{ root: string, isFile: boolean, path: string } | undefined>} the
 *   repository root, whether `.git` is a file (linked worktree or separate git dir) or a directory, and the entry path.
 */
export async function findGitEntry(start) {
  let dir = resolve(start)
  for (;;) {
    const candidate = join(dir, '.git')
    const info = await statOrAbsent(candidate)
    if (info !== undefined) return { root: dir, isFile: info.isFile(), path: candidate }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Git directory named by a `.git` file (`gitdir: <path>`), absolute.
 * @param {string} gitFile - path of the `.git` file.
 * @returns {Promise<string | undefined>} the git directory, or undefined when the file names none.
 */
async function gitdirOf(gitFile) {
  const text = await readOrAbsent(gitFile)
  if (text === undefined) return undefined
  const match = /^gitdir:\s*(.+)$/m.exec(text)
  if (match === null) return undefined
  const raw = match[1].trim()
  return isAbsolute(raw) ? raw : resolve(dirname(gitFile), raw)
}

/**
 * Main repository root for a linked worktree's `.git` file, read the way git
 * resolves it: the worktree's git directory names its common directory in
 * `commondir`, and a common directory named `.git` sits directly under the
 * main repository's root. This is the derivation `git worktree list` itself
 * uses for the main worktree, with the same blind spot: a repository whose
 * git directory lives elsewhere (`--separate-git-dir`) stores no pointer back
 * to its root, so nothing can be derived, and a separate git directory that
 * happens to be named `.git` is reported as its parent, as git reports it. A
 * `.git` file that is itself a separate git directory is not a worktree.
 * @param {string} gitFile - path of the `.git` file.
 * @returns {Promise<string | undefined>} the main repository root, or undefined when none can be derived.
 */
export async function mainRootOfWorktree(gitFile) {
  const gitdir = await gitdirOf(gitFile)
  if (gitdir === undefined) return undefined
  const commondirText = await readOrAbsent(join(gitdir, 'commondir'))
  if (commondirText === undefined) return undefined
  const raw = commondirText.trim()
  const common = isAbsolute(raw) ? raw : resolve(gitdir, raw)
  if (common === gitdir) return undefined
  return common.endsWith(`${sep}.git`) ? dirname(common) : undefined
}

/**
 * Project roots whose Claude Code memory may belong to `cwd`, most specific
 * first: the enclosing repository (a linked worktree's own path first, then
 * its main repository), then `cwd` itself for directories outside git. The
 * path is tried as given and as its real path, so a session entered through
 * a symbolic link still finds the repository behind it.
 * @param {string} cwd - absolute session working directory.
 * @returns {Promise<string[]>} distinct absolute candidates in lookup order.
 */
export async function projectRoots(cwd) {
  const given = resolve(cwd)
  let real
  try {
    real = await realpath(given)
  } catch (error) {
    if (!isAbsence(error)) throw error
    real = given
  }
  const roots = []
  for (const start of new Set([given, real])) {
    const git = await findGitEntry(start)
    if (git !== undefined) {
      roots.push(git.root)
      if (git.isFile) {
        const main = await mainRootOfWorktree(git.path)
        if (main !== undefined) roots.push(main)
      }
    }
    roots.push(start)
  }
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
    const info = await statOrAbsent(path)
    if (info?.isFile()) return { root, path, size: info.size, mtimeMs: info.mtimeMs }
  }
  return undefined
}

/**
 * The one project root under which the harness's own memory for `cwd` lives:
 * the main repository of a linked worktree, else the enclosing repository,
 * else the directory itself, all by real path. Unlike {@link projectRoots}
 * this is a single answer, because the model writes here and every session of
 * the project must converge on one directory.
 * @param {string} cwd - absolute session working directory.
 * @returns {Promise<string>} the canonical absolute root.
 */
export async function canonicalRoot(cwd) {
  const given = resolve(cwd)
  let real
  try {
    real = await realpath(given)
  } catch (error) {
    if (!isAbsence(error)) throw error
    real = given
  }
  const git = await findGitEntry(real)
  if (git === undefined) return real
  if (git.isFile) {
    const main = await mainRootOfWorktree(git.path)
    if (main !== undefined) return main
  }
  return git.root
}

/**
 * Locate the harness's own memory store for a working directory. The store is
 * announced to the model before it exists, so the result always names the
 * directory and index path; `size` and `mtimeMs` are present only when the
 * index is a regular file. Absence (`ENOENT`, `ENOTDIR`) is a result; any
 * other stat failure is thrown.
 * @param {string} cwd - absolute session working directory.
 * @param {string} ownMemoryHome - root holding one directory per project (normally `~/.dsh/memory`).
 * @param {{ stat?: boolean }} [options] - `stat: false` names the paths without touching the disk.
 * @returns {Promise<{ root: string, path: string, size?: number, mtimeMs?: number }>} the
 *   canonical project root, the `MEMORY.md` path, and its size and mtime when it was inspected and is a file.
 */
export async function locateOwnIndex(cwd, ownMemoryHome, { stat: inspect = true } = {}) {
  const root = await canonicalRoot(cwd)
  const path = join(ownMemoryHome, slugOf(root), 'MEMORY.md')
  if (!inspect) return { root, path }
  const info = await statOrAbsent(path)
  return info?.isFile() ? { root, path, size: info.size, mtimeMs: info.mtimeMs } : { root, path }
}

/**
 * The own memory directory for a working directory, as the write tools need it.
 * @param {string} cwd - absolute session working directory.
 * @param {string} ownMemoryHome - root holding one directory per project.
 * @returns {Promise<string>} the directory (not created).
 */
export async function ownMemoryDir(cwd, ownMemoryHome) {
  return join(ownMemoryHome, slugOf(await canonicalRoot(cwd)))
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
 * Frame both memory stores as one model-facing message. Either store may be
 * absent; a caller with neither enters nothing or a withdrawal. The Claude
 * Code index is read-only to the model; the harness's own store is the one
 * the model maintains through the `memory_save` / `memory_delete` tools, so
 * that section is rendered before its first entry and carries the writing
 * rules. The completeness claim is scoped to the indexes shown: a source that
 * is switched off is absent, not deleted.
 * @param {{ claude?: { path: string, text: string, truncated: boolean }, own?: { path: string, text?: string, truncated: boolean, loaded?: boolean }, maxLines?: number }} stores -
 *   the located and bounded indexes; `own.text` is undefined while the store has no entries, and
 *   `own.loaded: false` says the session does not read that index, so the model is told to read it before writing;
 *   `maxLines` is the index cap the model is warned about (default 200).
 * @returns {string} the complete `<system-reminder>` block.
 */
export function renderMemoryMessage({ claude, own, maxLines = 200 }) {
  const rest = (truncated) => truncated ? ' Only the beginning of this index is shown; read the file directly for the rest.' : ''
  const parts = [
    '<system-reminder>',
    'Persistent memory for this project, loaded by dsh-claude-memory at the start of each conversation. This message replaces any memory message shown earlier in this conversation. Each index shown below is complete and current: an entry missing from an index that is shown no longer exists. A source that is not shown is not being read in this session; do not infer deletions from its absence. Each index line names one memory file in that index\'s directory. Read a memory file with a shell `cat` only when the current task relates to it; never read them all at once. Do not copy memory contents into the repository.',
  ]
  if (claude !== undefined) {
    parts.push(
      '',
      `Contents of ${claude.path} (Claude Code's memory index for this project; its files live in ${dirname(claude.path)}). Claude Code owns these files: never create, edit, or delete anything in that directory, and never save a copy of an entry it already holds.${rest(claude.truncated)}`,
      '',
      claude.text.trimEnd(),
    )
  }
  if (own !== undefined) {
    const dir = dirname(own.path)
    if (own.loaded === false) {
      parts.push('', `Your own memory for this project lives in ${dir}. Its index ${own.path} is not loaded in this session; \`cat\` it before saving so you do not duplicate an entry.`)
    } else if (own.text === undefined) {
      parts.push('', `Your own memory for this project lives in ${dir}. It has no entries yet.`)
    } else {
      parts.push('', `Contents of ${own.path} (your own memory index for this project; its files live in ${dir}).${rest(own.truncated)}`, '', own.text.trimEnd())
    }
    parts.push(
      '',
      `Save a memory with the \`memory_save\` tool when you learn something a future session in this project would need and the repository itself does not record: who the user is and how they prefer to work (type \`user\`); a correction or confirmed approach the user gave, with its reason (\`feedback\`); ongoing work, goals, or constraints not derivable from the code or git history (\`project\`); a URL, ticket, or dashboard worth returning to (\`reference\`). Do not save what the code, the instruction files, or the git history already record, or what matters only to this conversation. Before saving, check your own index${claude === undefined ? '' : ' and the Claude Code index'} for an entry that already covers the fact: save under the same name to update your own entry instead of adding a duplicate, and \`memory_delete\` an entry of yours that turned out to be wrong. The tools are the only way to write this store; never edit ${dir} with file tools. Each memory holds one fact, with dates written in full; for feedback and project, end the content with **Why:** and **How to apply:** lines, and link related memories as [[their-name]]. The index is loaded up to ${maxLines} lines; keep it below that by merging and deleting, not by writing less.`,
    )
  }
  parts.push('</system-reminder>')
  return parts.join('\n')
}

/**
 * Frame the withdrawal that replaces an index the model has seen after every
 * store became absent or blank. With the harness's own store enabled this
 * never happens: that section is rendered even when empty.
 * @param {string} path - the `MEMORY.md` path shown earlier.
 * @returns {string} the complete `<system-reminder>` block.
 */
export function renderWithdrawnMessage(path) {
  return [
    '<system-reminder>',
    `The memory index shown earlier for this project (${path}) is no longer available: the file is missing or empty. Treat that earlier index as withdrawn and do not rely on it.`,
    '</system-reminder>',
  ].join('\n')
}
