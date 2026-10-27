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

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
  const lines = index.length === 0 ? [] : index.replace(/(?:\r?\n)+$/, '').split('\n')
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
  const lines = index.length === 0 ? [] : index.replace(/(?:\r?\n)+$/, '').split('\n')
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

/** Lock timing: a lock whose heartbeat stopped this long ago is presumed abandoned; a writer waits this long before giving up. */
export const LOCK_TIMING = Object.freeze({ staleMs: 10_000, waitMs: 10_000 })

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Create `path` exclusively with `content`, closing the handle whatever happens.
 * @param {string} path
 * @param {string} content
 * @returns {Promise<boolean>} false when the path already exists.
 */
async function createExclusive(path, content) {
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
  return true
}

/**
 * Remove `path` only while it still carries `token`, so a release never
 * removes a lock another writer took over in the meantime.
 * @param {string} path
 * @param {string} token
 */
async function removeIfOwned(path, token) {
  let owner
  try {
    owner = await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsence(error)) return
    throw error
  }
  if (owner === token) await rm(path, { force: true })
}

/**
 * Take over `lockPath` if it is abandoned. Takeover is serialized through a
 * second exclusive file, `<lock>.takeover`, so two waiters cannot both decide
 * the same lock is stale: under that mutex the lock is inspected again, and
 * only a file that is still the same inode and still past `staleMs` is
 * renamed away and removed. A takeover file itself older than `staleMs` is
 * the trace of a writer that died inside this function and is removed.
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {Promise<void>} resolves once the stale lock is gone, or at once when it was not stale or someone else is handling it.
 */
async function takeOverIfStale(lockPath, staleMs) {
  let before
  try {
    before = await stat(lockPath)
  } catch (error) {
    if (isAbsence(error)) return
    throw error
  }
  if (Date.now() - before.mtimeMs <= staleMs) return
  const mutex = `${lockPath}.takeover`
  if (!await createExclusive(mutex, `${process.pid}\n`)) {
    const info = await stat(mutex).catch(() => undefined)
    if (info !== undefined && Date.now() - info.mtimeMs > staleMs) await rm(mutex, { force: true })
    return
  }
  try {
    let again
    try {
      again = await stat(lockPath)
    } catch (error) {
      if (isAbsence(error)) return
      throw error
    }
    if (again.ino !== before.ino || Date.now() - again.mtimeMs <= staleMs) return
    const graveyard = `${lockPath}.stale.${process.pid}.${Date.now()}`
    try {
      await rename(lockPath, graveyard)
    } catch (error) {
      if (isAbsence(error)) return
      throw error
    }
    await rm(graveyard, { force: true })
  } finally {
    await rm(mutex, { force: true })
  }
}

/**
 * Hold `<dir>/.MEMORY.lock` while `task` runs, so writers in other processes
 * (a web and a headless session of one project) read and rewrite the index in
 * turn. The lock is an exclusively created file carrying the holder's token;
 * the holder touches it every quarter of `staleMs` while the task runs, so a
 * long write is not mistaken for an abandoned one, and releases it only while
 * it still carries its token. An abandoned lock is taken over through
 * {@link takeOverIfStale}.
 * @template T
 * @param {string} dir - the memory directory, which must exist.
 * @param {() => Promise<T>} task
 * @param {{ staleMs?: number, waitMs?: number }} [timing] - overrides for tests; production uses {@link LOCK_TIMING}.
 * @returns {Promise<T>}
 * @throws {Error} when the lock stays held by a live writer past `waitMs`.
 */
export async function withStoreLock(dir, task, { staleMs = LOCK_TIMING.staleMs, waitMs = LOCK_TIMING.waitMs } = {}) {
  const lockPath = join(dir, '.MEMORY.lock')
  const token = `${process.pid}:${randomUUID()}\n`
  const deadline = Date.now() + waitMs
  while (!await createExclusive(lockPath, token)) {
    await takeOverIfStale(lockPath, staleMs)
    if (Date.now() > deadline) throw new Error(`memory store ${dir} is locked by another writer (${lockPath}); try again`)
    await sleep(10 + Math.random() * 20)
  }
  const now = () => new Date()
  const heartbeat = setInterval(() => { utimes(lockPath, now(), now()).catch(() => {}) }, Math.max(1, Math.floor(staleMs / 4)))
  heartbeat.unref?.()
  try {
    return await task()
  } finally {
    clearInterval(heartbeat)
    await removeIfOwned(lockPath, token)
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
  const run = previous.then(() => withStoreLock(dir, task), () => withStoreLock(dir, task))
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
    return { path, indexPath, created: !index.replaced, indexLines: index.lines, indexChars: index.text.replace(/(?:\r?\n)+$/, '').length }
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
  const path = join(dir, `${name}.md`)
  const indexPath = join(dir, 'MEMORY.md')
  // A project without a store has nothing to delete, and gets no directory for asking.
  try {
    await stat(dir)
  } catch (error) {
    if (!isAbsence(error)) throw error
    return { path, indexPath, removedFile: false, removedLines: 0, indexLines: 0 }
  }
  return serialized(dir, async () => {
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
