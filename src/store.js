/**
 * Pure helpers for the harness's own memory store: one memory file per
 * fact, in the format Claude Code uses for its auto memory, and the
 * `MEMORY.md` index as a projection of those files. Nothing here touches the
 * harness; `node --test` covers it with temporary directories. The plugin
 * exposes the writers through the `memory_save` and `memory_delete` tools
 * because the file sandbox denies the model's own file tools outside the
 * workspace.
 *
 * The entry files are the only source of truth. {@link projectIndex} derives
 * the index text from them, and both the reader (the plugin's first step)
 * and the writers go through it: a save or delete writes its own entry file
 * atomically and then rewrites `MEMORY.md` from a fresh listing; a read
 * derives the text the same way and rewrites the file when it disagrees.
 * The file on disk is therefore a cache that may lag behind the entries
 * while writers overlap, and what the model sees never does. No lock file is
 * involved and nothing is read-modify-written. The price is that an index
 * line edited by hand is replaced by the entry's own `title` and `hook`; the
 * entry file is the place to edit. An entry written by hand (no `title` or
 * `hook`) keeps the index line it already has, else indexes under its name
 * and description.
 * @module dsh-claude-memory/store
 */

import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isAbsence } from './locate.js'

/** Memory types Claude Code distinguishes; the tool enum and the frontmatter value. */
export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'])

/** Grammar of a name the save tool accepts: lower-case kebab-case, the way Claude Code names its memories. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Grammar of a file stem the index lists: one path segment of letters,
 * digits, dots, hyphens and underscores, so a file copied from Claude Code
 * (`feedback_testing.md`) indexes too. No leading dot, so `.` and `..` and
 * temporary files are out; no bracket or parenthesis, so the stem cannot
 * break its own index link.
 */
const ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Stems a memory may not take: `memory` is `MEMORY.md` on a case-insensitive
 * file system (APFS by default), so saving it would overwrite the index and
 * deleting it would remove the index.
 */
const RESERVED_NAMES = new Set(['memory'])

/**
 * @param {string} name - candidate memory name.
 * @returns {boolean} whether the save tool may create it: a valid, unreserved kebab-case stem.
 */
export function isMemoryName(name) {
  return typeof name === 'string' && name.length <= 100 && NAME_PATTERN.test(name) && !RESERVED_NAMES.has(name.toLowerCase())
}

/**
 * @param {string} name - candidate file stem.
 * @returns {boolean} whether a file of that stem is an entry of the store, and so may be listed or deleted.
 */
export function isEntryName(name) {
  return typeof name === 'string' && name.length <= 100 && ENTRY_PATTERN.test(name) && !RESERVED_NAMES.has(name.toLowerCase())
}

/**
 * One line of text with no line breaks of any kind, for frontmatter values and the index.
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.replace(/\s*(?:\r\n|\r|\n|\u2028|\u2029)\s*/g, ' ').trim()
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
 * The value of a YAML flow scalar as this store reads it: double-quoted
 * (JSON escapes), single-quoted (`''` for a quote), or bare with a trailing
 * ` # comment` dropped. A quoted scalar that does not parse is kept as text.
 * @param {string} raw - the text after `key:`, trimmed.
 * @returns {string}
 */
function flowScalar(raw) {
  if (raw.startsWith('"')) {
    try {
      return String(JSON.parse(raw))
    } catch {
      return raw
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1).replace(/''/g, "'")
  return raw.replace(/\s+#.*$/, '').trim()
}

/**
 * The top-level fields of a file's leading YAML frontmatter block. Only the
 * subset a memory file uses is understood: `key: value` at column zero with
 * a double-quoted, single-quoted or bare value, or a block scalar (`|`, `>`,
 * with `-` or `+`) whose indented lines are joined into one value; a nested
 * mapping such as `metadata:` is skipped. A byte order mark is ignored.
 * @param {string} text - file text.
 * @returns {Record<string, string>} the fields found, possibly none.
 */
export function parseFrontmatter(text) {
  const fields = {}
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match === null) return fields
  const lines = match[1].split(/\r?\n/)
  for (let at = 0; at < lines.length; at += 1) {
    const pair = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[at])
    if (pair === null) continue
    const raw = (pair[2] ?? '').trim()
    if (raw.length === 0) continue
    if (/^[|>][+-]?$/.test(raw)) {
      const block = []
      while (at + 1 < lines.length && (lines[at + 1].trim().length === 0 || /^\s/.test(lines[at + 1]))) {
        at += 1
        block.push(lines[at].trim())
      }
      fields[pair[1]] = block.join(raw.startsWith('|') ? '\n' : ' ').trim()
    } else fields[pair[1]] = flowScalar(raw)
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
 * The index lines of a text by the name each is the entry for, first line per name, in order.
 * @param {string} text
 * @returns {Map<string, string>}
 */
function indexLines(text) {
  const lines = new Map()
  for (const line of text.split(/\r?\n/)) {
    const name = indexLineName(line)
    if (name !== undefined && !lines.has(name)) lines.set(name, line)
  }
  return lines
}

/**
 * The names an index text lists, in order, each once.
 * @param {string} text
 * @returns {string[]}
 */
export function indexOrder(text) {
  return [...indexLines(text).keys()]
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
 * @param {string | undefined} value
 * @returns {string | undefined} the value unless it is empty.
 */
const nonEmpty = (value) => (value !== undefined && value.trim().length > 0 ? value : undefined)

/**
 * Every memory entry in a directory: each regular file `<name>.md` with an
 * entry name (symbolic links are not followed), read for its index fields.
 * An entry that vanishes between the listing and the read (a concurrent
 * delete) is simply absent; one that cannot be read for another reason is
 * reported in `skipped` and the rest still list. A file without `title` or
 * `hook` (written by hand, or copied from Claude Code) is marked `indexed:
 * false` and indexes under its name and description.
 * @param {string} dir
 * @returns {Promise<{ entries: { name: string, title: string, hook: string, mtimeMs: number, indexed: boolean }[], skipped: { name: string, error: Error }[] }>}
 *   entries sorted by name; an absent directory has none.
 */
export async function listEntries(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isAbsence(error)) return { entries: [], skipped: [] }
    throw error
  }
  const entries = []
  const skipped = []
  for (const file of names) {
    if (!file.endsWith('.md')) continue
    const name = file.slice(0, -3)
    if (!isEntryName(name)) continue
    const path = join(dir, file)
    let text
    let info
    try {
      info = await lstat(path)
      if (!info.isFile()) continue
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (!isAbsence(error)) skipped.push({ name, error })
      continue
    }
    const fields = parseFrontmatter(text)
    const indexed = nonEmpty(fields.title) !== undefined || nonEmpty(fields.hook) !== undefined
    entries.push({
      name,
      title: nonEmpty(fields.title) ?? nonEmpty(fields.name) ?? name,
      hook: nonEmpty(fields.hook) ?? nonEmpty(fields.description) ?? '',
      mtimeMs: info.mtimeMs,
      indexed,
    })
  }
  return { entries: entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), skipped }
}

/**
 * The index text for a set of entries. Names already in the previous index
 * keep their order, newer entries follow in the order they were written. An
 * entry that carries its own index fields renders from them; one that does
 * not keeps the line the previous index had for it.
 * @param {{ name: string, title: string, hook: string, mtimeMs: number, indexed?: boolean }[]} entries
 * @param {string} previous - the previous index text.
 * @returns {string} the index text, newline-terminated, or '' for no entries.
 */
export function renderIndex(entries, previous) {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const kept = indexLines(previous)
  const line = (entry) => (entry.indexed === false && kept.has(entry.name) ? kept.get(entry.name).trimEnd() : renderIndexLine(entry))
  const ordered = []
  for (const name of kept.keys()) {
    const entry = byName.get(name)
    if (entry !== undefined) {
      ordered.push(entry)
      byName.delete(name)
    }
  }
  const fresh = [...byName.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1))
  const lines = [...ordered, ...fresh].map(line)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * @param {string} text - index text.
 * @returns {{ indexLines: number, indexChars: number }} line and UTF-16 code unit counts without the final newline, as the reader counts.
 */
function measure(text) {
  const body = text.replace(/(?:\r?\n)+$/, '')
  return { indexLines: body.length === 0 ? 0 : body.split('\n').length, indexChars: body.length }
}

/**
 * Derive the index of a directory from its entry files, without writing.
 * This is what the model is shown; the file on disk is only its cache.
 * @param {string} dir
 * @returns {Promise<{ indexPath: string, text: string, stale: boolean, skipped: { name: string, error: Error }[], indexLines: number, indexChars: number }>}
 *   the index text, whether the file on disk differs from it, and the entries that could not be read and so are missing from it.
 */
export async function projectIndex(dir) {
  const indexPath = join(dir, 'MEMORY.md')
  const [{ entries, skipped }, previous] = await Promise.all([listEntries(dir), readOrEmpty(indexPath)])
  const text = renderIndex(entries, previous)
  return { indexPath, text, stale: text !== previous, skipped, ...measure(text) }
}

/**
 * Project the index and rewrite `<dir>/MEMORY.md` when it differs. Not
 * serialized: callers hold the directory's turn.
 * @param {string} dir
 * @returns {Promise<Awaited<ReturnType<typeof projectIndex>> & { written: boolean }>}
 */
async function rebuildIndex(dir) {
  const index = await projectIndex(dir)
  if (index.stale) await writeAtomic(index.indexPath, index.text)
  return { ...index, written: index.stale }
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
 * Bring `<dir>/MEMORY.md` up to date with the entry files: the repair a
 * reader runs when the projection disagrees with the file. An absent
 * directory stays absent.
 * @param {string} dir
 * @returns {Promise<Awaited<ReturnType<typeof rebuildIndex>>>}
 */
export function syncIndex(dir) {
  return serialized(dir, () => rebuildIndex(dir))
}

/**
 * Create or replace one memory and rewrite the index from the entry files.
 * @param {string} dir - the project's own memory directory, created when missing.
 * @param {{ name: string, description: string, type: string, title: string, hook: string, content: string, sessionId: string, modified?: Date }} memory
 * @returns {Promise<{ path: string, indexPath: string, created: boolean, indexLines: number, indexChars: number }>} where the file
 *   went, whether it is new, and the index's line and UTF-16 code unit counts after the write, which the caller measures
 *   against the read caps the way Claude Code does after every index write.
 * @throws {TypeError} for a name the save tool does not accept; nothing is written.
 */
export async function saveMemory(dir, memory) {
  if (!isMemoryName(memory.name)) throw new TypeError(`not a memory name: ${JSON.stringify(memory.name)}`)
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
 * Remove one memory and rewrite the index from the entry files. A memory
 * that is already gone is not an error: the end state is what the caller
 * asked for.
 * @param {string} dir - the project's own memory directory.
 * @param {string} name - entry name, as the index lists it.
 * @returns {Promise<{ path: string, indexPath: string, removedFile: boolean, removedLines: number, indexLines: number }>}
 * @throws {TypeError} for a name that is not an entry name; nothing is removed.
 */
export async function deleteMemory(dir, name) {
  if (!isEntryName(name)) throw new TypeError(`not an entry name: ${JSON.stringify(name)}`)
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
