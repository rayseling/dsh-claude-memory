/**
 * Pure helpers for the harness's own memory store: one memory file per
 * fact, in the format Claude Code uses for its auto memory, and the
 * `MEMORY.md` index as a projection of those files. Nothing here touches the
 * harness; `node --test` covers it with temporary directories. The plugin
 * exposes the writers through the `memory_save` and `memory_delete` tools
 * because the file sandbox denies the model's own file tools outside the
 * workspace.
 *
 * Three contracts hold throughout:
 *
 * 1. The entry files are the only source of truth, and the projection never
 *    fails because of the index file. {@link projectIndex} lists the entry
 *    files and renders the index from their `title` and `hook`; the index
 *    file on disk is a cache consulted only as a hint (the order of the
 *    lines, and the line to keep for an entry that carries no fields of its
 *    own or cannot be read right now). A cache that is missing, unreadable,
 *    a directory, a FIFO or a symbolic link counts as empty and is reported,
 *    never thrown. A readable entry therefore always appears.
 * 2. Commit and repair are separate. A save or delete first writes or
 *    removes its own entry file atomically, which commits the change; then
 *    it rewrites the cache from a fresh projection as best effort and
 *    reports a repair failure beside the committed result rather than as a
 *    failure of the commit. The reader (the plugin's first step) projects the
 *    same way and repairs the cache when it disagrees, so a cache left
 *    behind by an overlapping or interrupted write is corrected on the next
 *    read and what the model sees never depends on it.
 * 3. What is not a readable entry of this store is reported, not dropped. A
 *    `.md` file whose stem is not an entry name, that is not a regular file,
 *    or that cannot be read is listed as skipped, keeps the line the cache
 *    had for it, and is warned about by the caller. Frontmatter is parsed
 *    for the YAML subset a memory file uses; an empty or null value counts
 *    as absent and falls back.
 *
 * No lock file is involved and nothing is read-modify-written. The price is
 * that the cache is replaced wholesale: an index line edited by hand for an
 * entry that carries `title` and `hook`, and any line that is not an entry
 * line, are gone after the next projection.
 * @module dsh-claude-memory/store
 */

import { lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isAbsence } from './locate.js'

/** Memory types Claude Code distinguishes; the tool enum and the frontmatter value. */
export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'])

/** The index file's name; compared case-insensitively because APFS is. */
export const INDEX_NAME = 'MEMORY.md'

/** Grammar of a name the save tool accepts: lower-case kebab-case, the way Claude Code names its memories. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Grammar of a file stem the index can link: one path segment of letters,
 * digits, dots, hyphens and underscores, so a file copied from Claude Code
 * (`feedback_testing.md`) indexes too. No leading dot, so `.` and `..` are
 * out; no space, bracket or parenthesis, so the stem cannot break its own
 * index link. A `.md` file outside this grammar is reported as skipped.
 */
const ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Stems a memory may not take: `memory` is `MEMORY.md` on a case-insensitive
 * file system (APFS by default), so saving it would overwrite the index and
 * deleting it would remove the index.
 */
const RESERVED_NAMES = new Set(['memory'])

/** Bytes read from any one file this store inspects; frontmatter and index order hints need far less. */
const HEAD_BYTES = 1 << 18

/**
 * @param {string} name - candidate memory name.
 * @returns {boolean} whether the save tool may create it: a valid, unreserved kebab-case stem.
 */
export function isMemoryName(name) {
  return typeof name === 'string' && name.length <= 100 && NAME_PATTERN.test(name) && !RESERVED_NAMES.has(name.toLowerCase())
}

/**
 * @param {string} name - candidate file stem.
 * @returns {boolean} whether a file of that stem is an entry of the store, and so may be linked or deleted.
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
 * (JSON escapes), single-quoted (`''` for a quote), or bare, each with a
 * trailing ` # comment` dropped. An empty string, `null`, `~`, `[]` and `{}`
 * are absent. A quoted scalar that does not close is kept as text.
 * @param {string} raw - the text after `key:`, trimmed.
 * @returns {string | undefined}
 */
function flowScalar(raw) {
  let value = raw
  const double = /^"((?:[^"\\]|\\.)*)"/.exec(raw)
  const single = /^'((?:[^']|'')*)'/.exec(raw)
  if (double !== null) {
    try {
      value = String(JSON.parse(double[0]))
    } catch {
      value = double[1]
    }
  } else if (single !== null) value = single[1].replace(/''/g, "'")
  else value = raw.replace(/(?:^|\s+)#.*$/, '').trim()
  if (value.length === 0 || (double === null && single === null && ['null', '~', '[]', '{}'].includes(value))) return undefined
  return value
}

/**
 * The top-level fields of a file's leading YAML frontmatter block. Only the
 * subset a memory file uses is understood: `key: value` at column zero with
 * a double-quoted, single-quoted or bare value, or a block scalar (`|`, `>`,
 * with `-` or `+`) whose indented lines are joined into one value; a nested
 * mapping such as `metadata:` is skipped, and so is a key whose value is
 * absent. A byte order mark is ignored.
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
    let value
    if (/^[|>][+-]?(?:\s+#.*)?$/.test(raw)) {
      const block = []
      while (at + 1 < lines.length && (lines[at + 1].trim().length === 0 || /^\s/.test(lines[at + 1]))) {
        at += 1
        block.push(lines[at].trim())
      }
      value = block.join(raw.startsWith('|') ? '\n' : ' ').trim()
      if (value.length === 0) value = undefined
    } else if (raw.length > 0) value = flowScalar(raw)
    if (value !== undefined) fields[pair[1]] = value
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
 * The index lines of a text by the name each is the entry for, first line per name, in order, without line endings.
 * @param {string} text
 * @returns {Map<string, string>}
 */
function indexLines(text) {
  const lines = new Map()
  for (const line of text.split(/\r?\n/)) {
    const name = indexLineName(line)
    if (name !== undefined && !lines.has(name)) lines.set(name, line.trimEnd())
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
 * The first bytes of a regular file as text. The file is inspected with
 * `lstat` before it is opened, so a FIFO never blocks and a symbolic link,
 * looping or not, is never followed; such a file fails with code `ENOTREG`.
 * A file longer than the ceiling is cut, possibly inside a character, which
 * the two uses (frontmatter, index order) tolerate.
 * @param {string} path
 * @returns {Promise<{ text: string, mtimeMs: number }>}
 */
async function readHead(path) {
  const info = await lstat(path)
  if (!info.isFile()) throw Object.assign(new Error(`${path} is not a regular file`), { code: 'ENOTREG' })
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, HEAD_BYTES))
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return { text: buffer.subarray(0, filled).toString('utf8'), mtimeMs: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

/**
 * The cache's text as a hint, never as a failure: absent or unusable is ''.
 * @param {string} indexPath
 * @returns {Promise<{ text: string, error?: Error }>} the text, and the error when the file exists but could not be used.
 */
async function readCache(indexPath) {
  try {
    return { text: (await readHead(indexPath)).text }
  } catch (error) {
    return isAbsence(error) ? { text: '' } : { text: '', error }
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
 * @returns {string | undefined} the value unless it is blank.
 */
const nonEmpty = (value) => (value !== undefined && value.trim().length > 0 ? value : undefined)

/**
 * @typedef {{ name: string, title: string, hook: string, mtimeMs: number, indexed: boolean }} Entry
 *   a readable entry; `indexed` says the file carries its own `title` or `hook`.
 * @typedef {{ name: string, reason: 'name' | 'unreadable', error?: Error }} Skipped
 *   a `.md` file that is not a readable entry: its stem is outside the entry grammar, or it is not a regular file or cannot be read.
 */

/**
 * Every `.md` file in a directory, as entries or as skipped. The index file
 * and dot-files (editor and temporary files) are neither. A file that
 * vanishes between the listing and the read (a concurrent delete) is
 * simply absent. A file without `title` or `hook` (written by hand, or
 * copied from Claude Code) is `indexed: false` and indexes under its name
 * and description unless the cache has a line for it.
 * @param {string} dir
 * @returns {Promise<{ entries: Entry[], skipped: Skipped[] }>} both sorted by name; an absent directory has none.
 * @throws when the directory itself cannot be listed.
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
    if (!file.endsWith('.md') || file.startsWith('.') || file.toLowerCase() === INDEX_NAME.toLowerCase()) continue
    const name = file.slice(0, -3)
    if (!isEntryName(name)) {
      skipped.push({ name, reason: 'name' })
      continue
    }
    let head
    try {
      head = await readHead(join(dir, file))
    } catch (error) {
      if (!isAbsence(error)) skipped.push({ name, reason: 'unreadable', error })
      continue
    }
    const fields = parseFrontmatter(head.text)
    const indexed = nonEmpty(fields.title) !== undefined || nonEmpty(fields.hook) !== undefined
    entries.push({
      name,
      title: nonEmpty(fields.title) ?? nonEmpty(fields.name) ?? name,
      hook: nonEmpty(fields.hook) ?? nonEmpty(fields.description) ?? '',
      mtimeMs: head.mtimeMs,
      indexed,
    })
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return { entries: entries.sort(byName), skipped: skipped.sort(byName) }
}

/**
 * The index text for a set of entries. Names already in the previous index
 * keep their order, newer entries follow in the order they were written. An
 * entry that carries its own index fields renders from them; one that does
 * not keeps the line the previous index had for it; a skipped name keeps
 * its previous line too, so a title and hook that exist nowhere else
 * survive the file being unreadable for a while.
 * @param {Entry[]} entries
 * @param {string} previous - the previous index text.
 * @param {Iterable<string>} [skipped] - names to keep from the previous index verbatim.
 * @returns {string} the index text, newline-terminated, or '' for no lines.
 */
export function renderIndex(entries, previous, skipped = []) {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const keep = new Set(skipped)
  const lines = []
  for (const [name, line] of indexLines(previous)) {
    const entry = byName.get(name)
    if (entry !== undefined) {
      lines.push(entry.indexed === false ? line : renderIndexLine(entry))
      byName.delete(name)
    } else if (keep.has(name)) lines.push(line)
  }
  const fresh = [...byName.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1))
  lines.push(...fresh.map(renderIndexLine))
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
 * @typedef {{ indexPath: string, text: string, stale: boolean, skipped: Skipped[], omitted: Skipped[], cacheError?: Error, indexLines: number, indexChars: number }} Projection
 *   `text` is the index as the model should see it; `stale` says the cache differs from it; `skipped` are the files
 *   that are not readable entries, of which `omitted` have no line in the projection at all; `cacheError` says the
 *   cache exists but could not be used as a hint.
 */

/**
 * Derive the index of a directory from its entry files, without writing.
 * This is what the model is shown; the file on disk is only its cache.
 * @param {string} dir
 * @returns {Promise<Projection>}
 * @throws only when the directory itself cannot be listed.
 */
export async function projectIndex(dir) {
  const indexPath = join(dir, INDEX_NAME)
  const [{ entries, skipped }, cache] = await Promise.all([listEntries(dir), readCache(indexPath)])
  const text = renderIndex(entries, cache.text, skipped.map((entry) => entry.name))
  const shown = indexLines(text)
  const omitted = skipped.filter((entry) => !shown.has(entry.name))
  return { indexPath, text, stale: text !== cache.text, skipped, omitted, ...(cache.error === undefined ? {} : { cacheError: cache.error }), ...measure(text) }
}

/**
 * Project the index and rewrite the cache when it differs. The rewrite is
 * best effort: its failure is returned as `repairError`, not thrown. Not
 * serialized; callers hold the directory's turn.
 * @param {string} dir
 * @returns {Promise<Projection & { written: boolean, repairError?: Error }>}
 * @throws only when the directory itself cannot be listed.
 */
async function rebuildIndex(dir) {
  const index = await projectIndex(dir)
  if (!index.stale) return { ...index, written: false }
  try {
    await writeAtomic(index.indexPath, index.text)
    return { ...index, written: true }
  } catch (repairError) {
    return { ...index, written: false, repairError }
  }
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
 * Bring the cache up to date with the entry files: the repair a reader runs
 * when the projection disagrees with the file. An absent directory stays
 * absent.
 * @param {string} dir
 * @returns {Promise<Awaited<ReturnType<typeof rebuildIndex>>>}
 * @throws only when the directory itself cannot be listed.
 */
export function syncIndex(dir) {
  return serialized(dir, () => rebuildIndex(dir))
}

/**
 * The cache repair that follows a commit: never throws, so a committed
 * entry is reported as committed whatever the cache does.
 * @param {string} dir
 * @returns {Promise<{ index?: Projection, indexError?: Error }>} the projection when one could be made, and the error
 *   that kept the cache from being rewritten (or the directory from being listed).
 */
async function repairAfterCommit(dir) {
  try {
    const index = await rebuildIndex(dir)
    return index.repairError === undefined ? { index } : { index, indexError: index.repairError }
  } catch (indexError) {
    return { indexError }
  }
}

/**
 * Create or replace one memory (the commit), then rewrite the cache from the
 * entry files as best effort.
 * @param {string} dir - the project's own memory directory, created when missing.
 * @param {{ name: string, description: string, type: string, title: string, hook: string, content: string, sessionId: string, modified?: Date }} memory
 * @returns {Promise<{ path: string, indexPath: string, created: boolean, indexLines?: number, indexChars?: number, indexError?: Error }>}
 *   where the file went and whether it is new; the index's line and UTF-16 code unit counts after the write when the
 *   projection could be made, which the caller measures against the read caps the way Claude Code does after every
 *   index write; and the error when the cache could not be rewritten, which the caller reports beside the committed save.
 * @throws {TypeError} for a name the save tool does not accept; nothing is written.
 * @throws when the entry itself cannot be written; then nothing is committed.
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
    const { index, indexError } = await repairAfterCommit(dir)
    return {
      path,
      indexPath: join(dir, INDEX_NAME),
      created,
      ...(index === undefined ? {} : { indexLines: index.indexLines, indexChars: index.indexChars }),
      ...(indexError === undefined ? {} : { indexError }),
    }
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
 * Remove one memory (the commit), then rewrite the cache from the entry
 * files as best effort. A memory that is already gone is not an error: the
 * end state is what the caller asked for.
 * @param {string} dir - the project's own memory directory.
 * @param {string} name - entry name, as the index links it.
 * @returns {Promise<{ path: string, indexPath: string, removedFile: boolean, indexLines?: number, indexError?: Error }>}
 * @throws {TypeError} for a name that is not an entry name; nothing is removed.
 * @throws when the entry exists but cannot be removed; then nothing is committed.
 */
export async function deleteMemory(dir, name) {
  if (!isEntryName(name)) throw new TypeError(`not an entry name: ${JSON.stringify(name)}`)
  const path = join(dir, `${name}.md`)
  const indexPath = join(dir, INDEX_NAME)
  // A project without a store has nothing to delete, and gets no directory for asking.
  try {
    await stat(dir)
  } catch (error) {
    if (!isAbsence(error)) throw error
    return { path, indexPath, removedFile: false, indexLines: 0 }
  }
  return serialized(dir, async () => {
    let removedFile = true
    try {
      await rm(path)
    } catch (error) {
      if (!isAbsence(error)) throw error
      removedFile = false
    }
    const { index, indexError } = await repairAfterCommit(dir)
    return {
      path,
      indexPath,
      removedFile,
      ...(index === undefined ? {} : { indexLines: index.indexLines }),
      ...(indexError === undefined ? {} : { indexError }),
    }
  })
}
