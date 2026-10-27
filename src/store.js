/**
 * Pure helpers that write the harness's own memory store: one memory file
 * per fact, in the format Claude Code uses for its auto memory, and the
 * `MEMORY.md` index as a projection of those files. Nothing here touches the
 * harness; `node --test` covers it with temporary directories. The plugin
 * exposes these through the `memory_save` and `memory_delete` tools because
 * the file sandbox denies the model's own file tools outside the workspace.
 *
 * The index is never read-modify-written. A save writes its own entry file
 * (atomically, by rename), then rebuilds the index from every entry file in
 * the directory, then lists the directory again and rebuilds once more if it
 * changed meanwhile. Two writers in different processes can therefore never
 * lose each other's line: whichever index write lands last was computed from
 * a listing taken after every entry written before it, and a writer whose
 * entry appeared later rebuilds again. No lock file is involved, so there is
 * no ownership to lose on an abandoned lock either. The price is that an
 * index line edited by hand is replaced by the entry's own `title` and `hook`
 * on the next write; the entry file is the place to edit.
 * @module dsh-claude-memory/store
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
 * A YAML double-quoted scalar, so a value with `:` or `#` stays one value.
 * @param {string} text
 * @returns {string}
 */
function yamlString(text) {
  return JSON.stringify(oneLine(text))
}

/**
 * Render a memory file: Claude Code's frontmatter (`name`, `description`,
 * `metadata.type`, plus the host-filled `node_type`, `originSessionId` and
 * `modified`), the two index fields `title` and `hook` this store adds so the
 * index can be rebuilt from the files, and the body.
 * @param {{ name: string, description: string, title: string, hook: string, type: string, content: string, sessionId: string, modified: Date }} memory
 * @returns {string} the file text, newline-terminated.
 */
export function renderMemoryFile({ name, description, title, hook, type, content, sessionId, modified }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    `title: ${yamlString(title)}`,
    `hook: ${yamlString(hook)}`,
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
 * The top-level scalar fields of a file's leading YAML frontmatter block.
 * Only the subset this store writes is understood: `key: value` lines, with
 * a JSON-quoted or bare value; nested blocks are skipped.
 * @param {string} text - file text.
 * @returns {Record<string, string>} the fields found, possibly none.
 */
export function parseFrontmatter(text) {
  const fields = {}
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match === null) return fields
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (pair === null) continue
    const raw = pair[2].trim()
    if (raw.length === 0) continue
    let value = raw
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
    }
    fields[pair[1]] = String(value)
  }
  return fields
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
 * The memory name an index line is the entry for: a list item (any marker,
 * any indentation) whose leading link, the one part of a line the writer
 * controls, points at `<name>.md`. A later link inside a hook is not an identity.
 * @param {string} line
 * @returns {string | undefined}
 */
export function indexLineName(line) {
  const match = /^\s*[-*+]\s+\[[^\]]*\]\(([^)/\\]+)\.md\)/.exec(line)
  return match === null ? undefined : match[1]
}

/**
 * The names an index text lists, in order, each once.
 * @param {string} text
 * @returns {string[]}
 */
export function indexOrder(text) {
  const names = []
  for (const line of text.split(/\r?\n/)) {
    const name = indexLineName(line)
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
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
 * (another session's first step) never sees a half-written file.
 * @param {string} path
 * @param {string} text
 */
async function writeAtomic(path, text) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Every memory entry in a directory: each `<name>.md` with a valid name,
 * read for its index fields. An entry that vanishes between the listing and
 * the read (a concurrent delete) is skipped. A file without `title` or `hook`
 * (written by hand, or copied from Claude Code) indexes under its name and
 * description.
 * @param {string} dir
 * @returns {Promise<{ name: string, title: string, hook: string, mtimeMs: number }[]>} sorted by name.
 */
export async function listEntries(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isAbsence(error)) return []
    throw error
  }
  const entries = []
  for (const file of names) {
    if (!file.endsWith('.md')) continue
    const name = file.slice(0, -3)
    if (!isMemoryName(name)) continue
    const path = join(dir, file)
    let text
    let info
    try {
      info = await stat(path)
      if (!info.isFile()) continue
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (isAbsence(error)) continue
      throw error
    }
    const fields = parseFrontmatter(text)
    entries.push({ name, title: fields.title ?? fields.name ?? name, hook: fields.hook ?? fields.description ?? '', mtimeMs: info.mtimeMs })
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/**
 * The index text for a set of entries: names already in the previous index
 * keep their order, newer entries follow in the order they were written.
 * @param {{ name: string, title: string, hook: string, mtimeMs: number }[]} entries
 * @param {string} previous - the previous index text, for ordering only.
 * @returns {string} the index text, newline-terminated, or '' for no entries.
 */
export function renderIndex(entries, previous) {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const ordered = []
  for (const name of indexOrder(previous)) {
    const entry = byName.get(name)
    if (entry !== undefined) {
      ordered.push(entry)
      byName.delete(name)
    }
  }
  const fresh = [...byName.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1))
  const lines = [...ordered, ...fresh].map(renderIndexLine)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * @param {{ name: string, mtimeMs: number }[]} entries
 * @returns {string} a fingerprint of which entries exist and when they were written.
 */
const fingerprint = (entries) => entries.map((entry) => `${entry.name}@${entry.mtimeMs}`).join('|')

/** How many times a writer rebuilds the index after seeing the directory change under it. */
const REBUILD_ROUNDS = 8

/**
 * Rebuild `<dir>/MEMORY.md` from the entry files until a rebuild sees the
 * same directory it was built from. The loop ends after a bounded number of
 * rounds; the last write is still built from a complete listing.
 * @param {string} dir
 * @returns {Promise<{ indexPath: string, text: string, indexLines: number, indexChars: number }>}
 */
async function rebuildIndex(dir) {
  const indexPath = join(dir, 'MEMORY.md')
  let entries = await listEntries(dir)
  let text = ''
  for (let round = 0; round < REBUILD_ROUNDS; round += 1) {
    text = renderIndex(entries, await readOrEmpty(indexPath))
    await writeAtomic(indexPath, text)
    const again = await listEntries(dir)
    if (fingerprint(again) === fingerprint(entries)) break
    entries = again
  }
  const body = text.replace(/(?:\r?\n)+$/, '')
  return { indexPath, text, indexLines: body.length === 0 ? 0 : body.split('\n').length, indexChars: body.length }
}

/** Pending write per directory, so two sessions of one process rebuild in turn rather than in parallel. */
const queues = new Map()

/**
 * Run `task` after every earlier task on the same directory in this process has settled.
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
 * Create or replace one memory and rebuild the index.
 * @param {string} dir - the project's own memory directory, created when missing.
 * @param {{ name: string, description: string, type: string, title: string, hook: string, content: string, sessionId: string, modified?: Date }} memory
 * @returns {Promise<{ path: string, indexPath: string, created: boolean, indexLines: number, indexChars: number }>} where the file
 *   went, whether it is new, and the index's line and UTF-16 code unit counts (without the final newline, as the reader
 *   counts) after the write, which the caller measures against the read caps the way Claude Code does after every index write.
 * @throws {TypeError} for a name that is not a valid, unreserved stem; nothing is written.
 */
export async function saveMemory(dir, memory) {
  assertMemoryName(memory.name)
  await mkdir(dir, { recursive: true })
  return serialized(dir, async () => {
    const path = join(dir, `${memory.name}.md`)
    let created = true
    try {
      await stat(path)
      created = false
    } catch (error) {
      if (!isAbsence(error)) throw error
    }
    await writeAtomic(path, renderMemoryFile({ ...memory, modified: memory.modified ?? new Date() }))
    const index = await rebuildIndex(dir)
    return { path, indexPath: index.indexPath, created, indexLines: index.indexLines, indexChars: index.indexChars }
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
 * Remove one memory and rebuild the index. A memory that is already gone is
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
    const listed = indexOrder(await readOrEmpty(indexPath)).includes(name)
    let removedFile = true
    try {
      await rm(path)
    } catch (error) {
      if (!isAbsence(error)) throw error
      removedFile = false
    }
    const index = await rebuildIndex(dir)
    return { path, indexPath, removedFile, removedLines: listed ? 1 : 0, indexLines: index.indexLines }
  })
}
