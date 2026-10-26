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

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isAbsence } from './locate.js'

/** Memory types Claude Code distinguishes; the tool enum and the frontmatter value. */
export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'])

/** File-name grammar: lower-case kebab-case, the way Claude Code names its memories. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * @param {string} name - candidate memory name.
 * @returns {boolean} whether it is a valid file stem.
 */
export function isMemoryName(name) {
  return typeof name === 'string' && name.length <= 100 && NAME_PATTERN.test(name)
}

/**
 * One line of text with no line breaks, for frontmatter values and the index.
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.replace(/\s*\n\s*/g, ' ').trim()
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
 * The index line for one memory: `- [Title](name.md) — hook`.
 * @param {{ name: string, title: string, hook: string }} entry
 * @returns {string}
 */
export function renderIndexLine({ name, title, hook }) {
  return `- [${oneLine(title).replace(/[[\]]/g, '')}](${name}.md) — ${oneLine(hook)}`
}

/**
 * Whether an index line points at `<name>.md`. The link target is the one
 * part of a line the writer controls, so it is the identity.
 * @param {string} line
 * @param {string} name
 * @returns {boolean}
 */
function pointsAt(line, name) {
  return new RegExp(`\\]\\(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md\\)`).test(line)
}

/**
 * Replace the line that points at `name` or append one; the rest of the
 * index is kept byte for byte.
 * @param {string} index - current index text ('' when the file is absent).
 * @param {string} name - memory name.
 * @param {string} line - the new line.
 * @returns {{ text: string, replaced: boolean, lines: number }} the new text, whether a line was replaced, and the line count.
 */
export function upsertIndexLine(index, name, line) {
  const lines = index.length === 0 ? [] : index.replace(/\n$/, '').split('\n')
  const at = lines.findIndex((existing) => pointsAt(existing, name))
  if (at === -1) lines.push(line)
  else lines[at] = line
  return { text: `${lines.join('\n')}\n`, replaced: at !== -1, lines: lines.length }
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

/** Pending write per directory, so two sessions of one project update the index in turn. */
const queues = new Map()

/**
 * Run `task` after every earlier task on the same directory has settled.
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function serialized(dir, task) {
  const previous = queues.get(dir) ?? Promise.resolve()
  const run = previous.then(task, task)
  queues.set(dir, run.catch(() => {}))
  return run
}

/**
 * Create or replace one memory and its index line.
 * @param {string} dir - the project's own memory directory, created when missing.
 * @param {{ name: string, description: string, type: string, title: string, hook: string, content: string, sessionId: string, modified?: Date }} memory
 * @returns {Promise<{ path: string, indexPath: string, created: boolean, indexLines: number }>} where the file went,
 *   whether it is new (no index line pointed at it before), and the index's line count after the write.
 */
export function saveMemory(dir, memory) {
  return serialized(dir, async () => {
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${memory.name}.md`)
    const indexPath = join(dir, 'MEMORY.md')
    await writeAtomic(path, renderMemoryFile({ ...memory, modified: memory.modified ?? new Date() }))
    const index = upsertIndexLine(await readOrEmpty(indexPath), memory.name, renderIndexLine(memory))
    await writeAtomic(indexPath, index.text)
    return { path, indexPath, created: !index.replaced, indexLines: index.lines }
  })
}

/**
 * Remove one memory and its index line. A memory that is already gone is
 * not an error: the end state is what the caller asked for.
 * @param {string} dir - the project's own memory directory.
 * @param {string} name - memory name.
 * @returns {Promise<{ path: string, indexPath: string, removedFile: boolean, removedLines: number, indexLines: number }>}
 */
export function deleteMemory(dir, name) {
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
