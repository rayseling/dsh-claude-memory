/**
 * Pure helpers that write the harness's own memory store: one memory file
 * plus its index line, in the format Claude Code uses for its auto memory.
 * Nothing here touches the harness; `node --test` covers it with temporary
 * directories. The plugin exposes these through the `memory_save` and
 * `memory_delete` tools because the file sandbox denies the model's own file
 * tools outside the workspace, and because a single writer in the server
 * process can keep the index consistent across concurrent sessions.
 * @module dsh-claude-memory/store
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isAbsence } from './locate.js'

/** Memory types Claude Code distinguishes; the tool enum and the frontmatter value. */
export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'])

/** File-name grammar: lower-case kebab-case, the way Claude Code names its memories. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Stems a memory may not take: `memory` is `MEMORY.md` on a case-insensitive
 * file system (APFS by default), so saving it would overwrite the index and
 * deleting it would remove the index.
 */
const RESERVED_NAMES = new Set(['memory'])

/**
 * @param {string} name - candidate memory name.
 * @returns {boolean} whether it is a valid, unreserved file stem.
 */
export function isMemoryName(name) {
  return typeof name === 'string' && name.length <= 100 && NAME_PATTERN.test(name) && !RESERVED_NAMES.has(name.toLowerCase())
}

/**
 * @param {string} name
 * @throws {TypeError} when the name is not a valid, unreserved stem; the store never touches the disk for such a name.
 */
function assertMemoryName(name) {
  if (!isMemoryName(name)) throw new TypeError(`not a memory name: ${JSON.stringify(name)}`)
}

/**
 * One line of text with no line breaks of any kind, for frontmatter values and the index.
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.replace(/\s*(?:\r\n|\r|\n)\s*/g, ' ').trim()
}

/**
 * A YAML double-quoted scalar, so a description with `:` or `#` stays one value.
 * @param {string} text
 * @returns {string}
 */
function yamlString(text) {
  return JSON.stringify(oneLine(text))
}

/**
 * Render a memory file: Claude Code's frontmatter (`name`, `description`,
 * `metadata.type`, plus the host-filled `node_type`, `originSessionId` and
 * `modified`) followed by the body.
 * @param {{ name: string, description: string, type: string, content: string, sessionId: string, modified: Date }} memory
 * @returns {string} the file text, newline-terminated.
 */
export function renderMemoryFile({ name, description, type, content, sessionId, modified }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${type}`,
    `  originSessionId: ${sessionId}`,
    `  modified: ${modified.toISOString()}`,
    '---',
    '',
    `${content.trim()}\n`,
  ].join('\n')
}

/**
 * Index-line text with angle brackets replaced by their full-width forms, so
 * a title or hook can never close or open a tag in the message the index is
 * later framed in.
 * @param {string} text
 * @returns {string}
 */
function tagSafe(text) {
  return oneLine(text).replace(/</g, '＜').replace(/>/g, '＞')
}

/**
 * The index line for one memory: `- [Title](name.md) — hook`.
 * @param {{ name: string, title: string, hook: string }} entry
 * @returns {string}
 */
export function renderIndexLine({ name, title, hook }) {
  return `- [${tagSafe(title).replace(/[[\]]/g, '')}](${name}.md) — ${tagSafe(hook)}`
}

/**
 * Whether an index line is the entry for `<name>.md`: a list item (any
 * marker, any indentation) whose leading link, the one part of a line the
 * writer controls, points at it. A later occurrence inside a hook is not an
 * identity.
 * @param {string} line
 * @param {string} name
 * @returns {boolean}
 */
function pointsAt(line, name) {
  return new RegExp(`^\\s*[-*+]\\s+\\[[^\\]]*\\]\\(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md\\)`).test(line)
}

/**
 * Replace the line that points at `name` or append one; the rest of the
 * index is kept byte for byte. Further lines pointing at the same name
 * (hand edits) are dropped, so the index has one line per memory.
 * @param {string} index - current index text ('' when the file is absent).
 * @param {string} name - memory name.
 * @param {string} line - the new line.
 * @returns {{ text: string, replaced: boolean, lines: number }} the new text, whether a line was replaced, and the line count.
 */
export function upsertIndexLine(index, name, line) {
  const lines = index.length === 0 ? [] : index.replace(/\n$/, '').split('\n')
  const at = lines.findIndex((existing) => pointsAt(existing, name))
  const kept = at === -1 ? [...lines, line] : lines.filter((existing, position) => position === at || !pointsAt(existing, name))
  if (at !== -1) kept[at] = line
  return { text: `${kept.join('\n')}\n`, replaced: at !== -1, lines: kept.length }
}

/**
 * Drop every line that points at `name`.
 * @param {string} index - current index text.
 * @param {string} name - memory name.
 * @returns {{ text: string, removed: number, lines: number }} the new text, how many lines went, and the line count.
 */
export function removeIndexLine(index, name) {
  const lines = index.length === 0 ? [] : index.replace(/\n$/, '').split('\n')
  const kept = lines.filter((existing) => !pointsAt(existing, name))
  return { text: kept.length === 0 ? '' : `${kept.join('\n')}\n`, removed: lines.length - kept.length, lines: kept.length }
}

/**
 * @param {string} path
 * @returns {Promise<string>} file text, or '' when the file is absent.
 */
async function readOrEmpty(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsence(error)) return ''
    throw error
  }
}

/**
 * Write a file through a sibling temporary name and a rename, so a reader
 * (another session's first step) never sees a half-written index.
 * @param {string} path
 * @param {string} text
 */
async function writeAtomic(path, text) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temp, text, 'utf8')
  await rename(temp, path)
}

/** Pending write per directory, so two sessions of one process update the index in turn. */
const queues = new Map()

/** How long a lock file may sit before it is presumed abandoned by a dead process. */
const LOCK_STALE_MS = 10_000

/** How long a writer waits for the lock before giving up. */
const LOCK_WAIT_MS = 10_000

/**
 * Hold `<dir>/.MEMORY.lock` while `task` runs, so writers in other processes
 * (a web and a headless session of one project) read and rewrite the index in
 * turn. The lock is an exclusively created file; a lock older than
 * {@link LOCK_STALE_MS} is removed as abandoned.
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function locked(dir, task) {
  const lockPath = join(dir, '.MEMORY.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    let handle
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await stat(lockPath).catch(() => undefined)
      if (info !== undefined && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`memory store ${dir} is locked by another writer (${lockPath}); try again`)
      await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20))
      continue
    }
    try {
      await handle.writeFile(`${process.pid}\n`)
      await handle.close()
      return await task()
    } finally {
      await rm(lockPath, { force: true })
    }
  }
}

/**
 * Run `task` after every earlier task on the same directory in this process
 * has settled, under the cross-process lock.
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function serialized(dir, task) {
  const previous = queues.get(dir) ?? Promise.resolve()
  const run = previous.then(() => locked(dir, task), () => locked(dir, task))
  queues.set(dir, run.catch(() => {}))
  return run
}

/**
 * Create or replace one memory and its index line.
 * @param {string} dir - the project's own memory directory, created when missing.
 * @param {{ name: string, description: string, type: string, title: string, hook: string, content: string, sessionId: string, modified?: Date }} memory
 * @returns {Promise<{ path: string, indexPath: string, created: boolean, indexLines: number, indexChars: number }>} where the file
 *   went, whether it is new (no index line pointed at it before), and the index's line and UTF-16 code unit counts (without
 *   the final newline, as the reader counts) after the write, which the caller measures against the read caps the way Claude
 *   Code does after every index write.
 * @throws {TypeError} for a name that is not a valid, unreserved stem; nothing is written.
 */
export async function saveMemory(dir, memory) {
  assertMemoryName(memory.name)
  await mkdir(dir, { recursive: true })
  return serialized(dir, async () => {
    const path = join(dir, `${memory.name}.md`)
    const indexPath = join(dir, 'MEMORY.md')
    await writeAtomic(path, renderMemoryFile({ ...memory, modified: memory.modified ?? new Date() }))
    const index = upsertIndexLine(await readOrEmpty(indexPath), memory.name, renderIndexLine(memory))
    await writeAtomic(indexPath, index.text)
    return { path, indexPath, created: !index.replaced, indexLines: index.lines, indexChars: index.text.replace(/\n$/, '').length }
  })
}

/**
 * Judge an index against the read caps the way Claude Code does after a
 * write: over either cap, everything past it is dropped on the next load;
 * near either cap (nine tenths or more), the index wants shortening.
 * @param {{ indexLines: number, indexChars: number }} index - counts after the write.
 * @param {{ maxLines: number, maxChars: number }} limits - the read caps.
 * @returns {'ok' | 'near' | 'over'}
 */
export function judgeIndex({ indexLines, indexChars }, { maxLines, maxChars }) {
  if (indexLines > maxLines || indexChars > maxChars) return 'over'
  if (indexLines * 10 >= maxLines * 9 || indexChars * 10 >= maxChars * 9) return 'near'
  return 'ok'
}

/**
 * Remove one memory and its index line. A memory that is already gone is
 * not an error: the end state is what the caller asked for.
 * @param {string} dir - the project's own memory directory.
 * @param {string} name - memory name.
 * @returns {Promise<{ path: string, indexPath: string, removedFile: boolean, removedLines: number, indexLines: number }>}
 * @throws {TypeError} for a name that is not a valid, unreserved stem; nothing is removed.
 */
export async function deleteMemory(dir, name) {
  assertMemoryName(name)
  await mkdir(dir, { recursive: true })
  return serialized(dir, async () => {
    const path = join(dir, `${name}.md`)
    const indexPath = join(dir, 'MEMORY.md')
    let removedFile = true
    try {
      await rm(path)
    } catch (error) {
      if (!isAbsence(error)) throw error
      removedFile = false
    }
    const current = await readOrEmpty(indexPath)
    const index = removeIndexLine(current, name)
    if (index.removed > 0) await writeAtomic(indexPath, index.text)
    return { path, indexPath, removedFile, removedLines: index.removed, indexLines: index.lines }
  })
}
