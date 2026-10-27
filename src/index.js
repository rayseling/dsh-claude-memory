/**
 * dsh-claude-memory — give a DeepSeek Harness session the persistent memory of
 * the project it works in: the Claude Code memory Claude Code maintains, read
 * the way Claude Code loads it, and the harness's own store, which the model
 * maintains with the same file format.
 *
 * At the first step of every turn the plugin locates the project's Claude
 * Code `MEMORY.md` and its own store (see `./locate.js`), reads each index
 * within Claude Code's own index cap, and enters both as one `user`-role
 * message with a producer-owned source (`plugin:claude-memory`, form
 * `snapshot`). The own-store section is present whenever that store is
 * enabled, entries or not, because it carries the directory and the writing
 * rules the model needs to create the first memory. The model writes through
 * the two tools described below, and the next turn re-enters the changed
 * index. The message is an ordinary
 * `user/message` session event, so it replays, compacts, and resumes like the
 * rest of the history and the model-visible state stays reconstructable from
 * the log.
 *
 * A session projection (`claudeMemory`) tracks the newest snapshot of this
 * plugin still on the surface and its content digest; it is maintained from
 * committed events, restored on resume, and cleared when a surface
 * replacement (compaction) shadows the snapshot. A turn whose visible
 * snapshot already carries the current digest enters nothing; a changed index
 * enters as a newer snapshot; an index that disappeared after being shown
 * enters a withdrawal snapshot.
 *
 * A second projection (`claudeMemoryMode`) holds the per-session read
 * switches, one per memory source (`claude`, `dsh`). A source the session
 * never switched sits on the configured `readByDefault`; `/memory <source>
 * on|off` appends one ignorable `plugin:claude-memory/mode` record per
 * accepted switch. A source switched off is not read and its index is not
 * entered. Writing is not a switch: whenever the own store is configured, the
 * model is told where it is and how to write to it, index loaded or not. The
 * switches are independent of the snapshot state, so a surface replacement
 * cannot change them, and they persist across resume. Switching a source off
 * never removes an index already shown to the model.
 *
 * Writes go through two tools this plugin registers, `memory_save` and
 * `memory_delete` (see `./store.js`), which write from the server process:
 * the host's file sandbox confines the model's own file tools to the
 * workspace and temp directories, so the store under `~/.dsh` would otherwise
 * need an approved escalation per write. The tools also fill the host-side
 * frontmatter (`originSessionId`, `modified`), serialize index updates per
 * directory, and can only reach the own store, never Claude Code's. As in
 * Claude Code, a subagent gets no memory tools unless `includeSubagents` is
 * set, and a session whose sandbox policy is `read-only` cannot write.
 *
 * Topic files are not loaded: the framing tells the model to `cat` one only
 * when the task relates to it, which is Claude Code's on-demand rule.
 * Subagent sessions get nothing by default, as in Claude Code. A session
 * without a recorded working directory gets nothing: there is no project to
 * attribute memory to, and the process directory would be another project's.
 * @module dsh-claude-memory
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as dshSession from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { locateMemoryIndex, locateOwnIndex, ownMemoryDir, readIndex, renderMemoryMessage, renderWithdrawnMessage, truncateIndex } from './locate.js'
import { MEMORY_TYPES, deleteMemory, isEntryName, isMemoryName, judgeIndex, projectIndex, saveMemory, syncIndex } from './store.js'

/** Stable Cordis plugin name. */
export const name = 'claude-memory'

/** The projection registry is required: it holds the per-session dedup state. */
export const inject = ['sessionProjections']

/** Producer-owned source kind of every message this plugin enters. */
export const SOURCE_KIND = `plugin:${name}`

/** Host plugin-record writer; absent before dsh-session 0.2.1-alpha.2. */
const appendPluginRecord = dshSession.appendPluginRecord

/** Session projection key owned by this plugin. */
export const PROJECTION_KEY = 'claudeMemory'

/** Session projection key holding the per-session, per-source read switches. */
export const MODE_PROJECTION_KEY = 'claudeMemoryMode'

/** Slash command name that toggles the switch. */
export const COMMAND_NAME = 'memory'

/** Stable command identity the client verifies before dispatching `/memory`. */
export const COMMAND_DEFINITION_ID = 'dsh-claude-memory'

/** Ignorable plugin-record type holding each accepted switch. */
export const MODE_EVENT_TYPE = 'plugin:claude-memory/mode'

/** Model-facing tool names for the own store. */
export const SAVE_TOOL_NAME = 'memory_save'
export const DELETE_TOOL_NAME = 'memory_delete'

/**
 * Readable memory sources in display order. `claude` is the Claude Code index,
 * `dsh` the harness's own store. A further harness's memory is added here,
 * in `readByDefault`, and in `currentStores`; state, command, and client rows
 * follow the list.
 */
export const SOURCES = Object.freeze(['claude', 'dsh'])

/** Plugin configuration; every field but `readByDefault` and the own store's has Claude Code's own value as default. */
export const Config = z.object({
  /** Claude Code configuration directory holding `projects/`. A leading `~/` expands to the home directory. */
  claudeHome: z.string().default(join(homedir(), '.claude')),
  /** Offer the model a memory store of its own, read and written beside the read-only Claude Code index. */
  ownMemory: z.boolean().default(true),
  /** Root of the own store, one `<slug>/` directory per project. A leading `~/` expands to the home directory. */
  ownMemoryHome: z.string().default(join(homedir(), '.dsh', 'memory')),
  /** Maximum index lines entered, as Claude Code caps its own load. */
  maxLines: z.number().step(1).min(1).default(200),
  /** Maximum index UTF-16 code units entered, as Claude Code caps its own load. */
  maxChars: z.number().step(1).min(1).default(25_000),
  /** Enter memory into sessions a subagent owns; Claude Code gives subagents none. */
  includeSubagents: z.boolean().default(false),
  /** Read switch of each source for a session that never switched it. Claude Code always loads its own; this plugin waits to be asked for it. */
  readByDefault: z.object({
    claude: z.boolean().default(false),
    dsh: z.boolean().default(true),
  }),
})

/**
 * @param {string} path - configured path.
 * @returns {string} the path with a leading `~/` expanded.
 */
function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/**
 * @param {string} text
 * @returns {string} hex sha256 of the rendered message.
 */
function digestOf(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Parse the `/memory` argument grammar: `[status]`, `<source> on|off`, or a
 * bare `on|off` that addresses every source.
 * @param {string} rawInput - text after the command name.
 * @returns {{ action: 'status' } | { action: 'set', sources: string[], enabled: boolean } | undefined} the
 *   request, or undefined for an unknown argument.
 */
export function parseMemoryCommand(rawInput) {
  const words = rawInput.trim().toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0 || (words.length === 1 && words[0] === 'status')) return { action: 'status' }
  const position = words.at(-1)
  if ((position !== 'on' && position !== 'off') || words.length > 2) return undefined
  if (words.length === 1) return { action: 'set', sources: [...SOURCES], enabled: position === 'on' }
  return SOURCES.includes(words[0]) ? { action: 'set', sources: [words[0]], enabled: position === 'on' } : undefined
}

/**
 * Validator for the persisted projection state (plain JSON).
 *
 * The registry's public type names a zod `ZodType`, but it erases the schema
 * to `{ parse(value) }` and calls only `parse` (session-projection
 * `ErasedDefinition`); this object satisfies that structural use without a
 * zod dependency. A host that starts calling `safeParse` would need a real
 * schema here.
 * @type {{ parse(value: unknown): { seq: number | null, digest: string | null, path: string | null } }}
 */
export const projectionStateSchema = {
  parse(value) {
    const ok = value !== null && typeof value === 'object'
      && (value.seq === null || (typeof value.seq === 'number' && Number.isInteger(value.seq)))
      && (value.digest === null || typeof value.digest === 'string')
      && (value.path === null || typeof value.path === 'string')
    if (!ok) throw new TypeError(`claude-memory: invalid projection state ${JSON.stringify(value)}`)
    return { seq: value.seq, digest: value.digest, path: value.path }
  },
}

/** Projection state for a session that shows no snapshot of this plugin. */
const EMPTY_STATE = Object.freeze({ seq: null, digest: null, path: null })

/**
 * Validator for the persisted read switches (plain JSON): `read` holds only
 * the sources the session switched explicitly, so a source missing from it
 * takes `readByDefault`; the default lives in configuration, not in the
 * state, so a changed default reaches every undecided session without
 * touching stored checkpoints. Keys outside {@link SOURCES} are kept, so a
 * source added later does not invalidate older checkpoints.
 * @type {{ parse(value: unknown): { read: Record<string, boolean> } }}
 */
export const modeStateSchema = {
  parse(value) {
    const read = value?.read
    const ok = read !== null && typeof read === 'object' && !Array.isArray(read)
      && Object.values(read).every((enabled) => typeof enabled === 'boolean')
    if (!ok) throw new TypeError(`claude-memory: invalid mode state ${JSON.stringify(value)}`)
    return { read: { ...read } }
  },
}

/**
 * Validator for the client view of the switches: every source with its
 * resolved position, in display order.
 * @type {{ parse(value: unknown): { sources: { id: string, enabled: boolean }[] } }}
 */
export const modeViewSchema = {
  parse(value) {
    const sources = value?.sources
    const ok = Array.isArray(sources)
      && sources.every((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.enabled === 'boolean')
    if (!ok) throw new TypeError(`claude-memory: invalid mode view ${JSON.stringify(value)}`)
    return { sources: sources.map(({ id, enabled }) => ({ id, enabled })) }
  },
}

/** Mode state for a session that has switched no source. */
export const MODE_UNSET = Object.freeze({ read: Object.freeze({}) })

/**
 * Pure fold: the newest snapshot of this plugin still on the surface.
 *
 * A surface replacement names every node it shadows in `sourceEventSeqs`
 * (the host requires that of a `replace` op), and that list is what decides
 * whether the snapshot left the surface: surface order is not seq order, so
 * the `startSeq..endSeq` range alone cannot say which nodes it spanned. The
 * range is consulted only when a replacement carries no source list.
 * @param {{ seq: number | null, digest: string | null, path: string | null }} state - prior state.
 * @param {object} event - committed session event.
 * @returns {{ seq: number | null, digest: string | null, path: string | null }} next state (same reference when unchanged).
 */
export function applyProjection(state, event) {
  if (event.type === 'user/message') {
    const source = event.data?.source
    if (source?.kind === SOURCE_KIND && source.form === 'snapshot') {
      return { seq: event.seq, digest: typeof source.digest === 'string' ? source.digest : null, path: typeof source.path === 'string' ? source.path : null }
    }
  }
  if (state.seq === null) return state
  const op = event.surfaceOp
  if (op === undefined || op === 'append' || op.op !== 'replace') return state
  const shadowed = Array.isArray(event.sourceEventSeqs)
    ? event.sourceEventSeqs.includes(state.seq)
    : op.startSeq <= state.seq && state.seq <= op.endSeq
  return shadowed ? EMPTY_STATE : state
}

/**
 * Pure fold for the per-session read switches. The command appends one
 * ignorable `MODE_EVENT_TYPE` record `{ source, enabled }` per accepted
 * switch; surface replacements and every other event leave the switches
 * alone, so compaction cannot reset them. A record without `source` was
 * written by 0.3.0 or 0.4.0, when the Claude Code index was the only source,
 * and is read as a switch of `claude`.
 * @param {{ read: Record<string, boolean> }} state - prior state.
 * @param {object} event - committed session event.
 * @returns {{ read: Record<string, boolean> }} next state (same reference when unchanged).
 */
export function applyModeProjection(state, event) {
  if (event.type !== MODE_EVENT_TYPE) return state
  const enabled = event.data?.enabled
  const source = event.data?.source ?? 'claude'
  if (typeof enabled !== 'boolean' || typeof source !== 'string' || state.read[source] === enabled) return state
  return { read: { ...state.read, [source]: enabled } }
}

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context with `sessionProjections`.
 * @param {z.infer<typeof Config>} config - validated configuration.
 */
export function apply(ctx, config) {
  const claudeHome = expandHome(config.claudeHome)
  const ownMemoryHome = expandHome(config.ownMemoryHome)
  // A relative home would resolve against the server's cwd here and against
  // the session's cwd in the model's eyes; run without the own store instead.
  let ownMemory = config.ownMemory
  if (ownMemory && !isAbsolute(ownMemoryHome)) {
    ctx.logger.warn(`claude-memory: ownMemoryHome must be an absolute path, got ${JSON.stringify(config.ownMemoryHome)}; the own store is off`)
    ownMemory = false
  }
  const limits = { maxLines: config.maxLines, maxChars: config.maxChars }
  /** Sources this deployment can read: `dsh` exists only with an own store. */
  const sources = SOURCES.filter((id) => id !== 'dsh' || ownMemory)
  /** Whether the host composed a tool registry and the write tools are on it. */
  let toolsRegistered = false
  /** Bounded index text per path, reused while the file's size and mtime hold. */
  const bounded = new Map()
  /** Paths already warned about per session, so a persistent read failure logs once. */
  const warned = new WeakMap()

  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 2,
    stateSchema: projectionStateSchema,
    init: () => EMPTY_STATE,
    apply: applyProjection,
  })

  /**
   * The read switches a session is on: its own choice per source, else the
   * configured default. A source this deployment lacks reads as off.
   * @returns {Record<string, boolean>} one entry per {@link SOURCES} id.
   */
  const resolveRead = (mode) => Object.fromEntries(SOURCES.map((id) => [id, sources.includes(id) && (mode.read[id] ?? config.readByDefault[id])]))
  const sameRead = (a, b) => SOURCES.every((id) => a[id] === b[id])
  /** Whether the host's sandbox policy, when composed, confines this session to `read-only`. */
  const readOnly = (session) => {
    const policy = ctx.get('sandboxPolicy')
    return policy !== undefined && policy.resolve({ session }).mode === 'read-only'
  }

  ctx.sessionProjections.register({
    key: MODE_PROJECTION_KEY,
    stateVersion: 3,
    stateSchema: modeStateSchema,
    init: () => MODE_UNSET,
    apply: applyModeProjection,
    // Client view: the composer menu lists every source with its resolved switch without knowing the defaults.
    wire: {
      viewSchema: modeViewSchema,
      view: (state) => {
        const read = resolveRead(state)
        return { sources: sources.map((id) => ({ id, enabled: read[id] })) }
      },
    },
  })

  // Optional: the write tools need the tool registry. Without it the own
  // section says the store cannot be written from this host.
  if (ownMemory) {
    ctx.inject(['tools'], (toolCtx) => {
      /**
       * The calling session's own memory directory, or a refusal: a call
       * without a session cwd has no project, a subagent gets no memory
       * unless configured (as in Claude Code), and a session confined to
       * `read-only` by the sandbox policy may not write anywhere.
       */
      const dirOf = async (exec) => {
        const session = exec.agent?.session
        const cwd = session?.header?.cwd
        if (cwd === undefined) throw new Error(`${exec.name ?? 'memory tool'} needs a session with a working directory; this call has none`)
        if (session.header.origin === 'subagent' && !config.includeSubagents) throw new Error('memory is not available to subagents in this profile (includeSubagents is off)')
        if (readOnly(session)) throw new Error('this session is read-only under the file policy; memory cannot be written')
        return ownMemoryDir(cwd, ownMemoryHome)
      }
      const disposers = []
      // The framing names the tools only while this scope, and so the tool
      // registry, is alive: the effect's disposer runs when the scope unloads.
      toolCtx.effect(() => () => {
        toolsRegistered = false
      }, 'claude-memory: memory tools')
      /**
       * Claude Code measures the index after every write: near a cap it
       * reminds the model to shorten it; over a cap the write stands but the
       * tool reports an error, because the excess is dropped on the next load.
       */
      const indexVerdict = (saved) => {
        const size = `${saved.indexLines} lines / ${saved.indexChars} characters`
        const caps = `${limits.maxLines} lines / ${limits.maxChars} characters`
        switch (judgeIndex(saved, limits)) {
          case 'over':
            throw new Error(`the memory was saved, but this write left the index ${saved.indexPath} at ${size}, over its ${caps} read limit; everything past the limit is dropped on the next load. Shorten the index now: merge overlapping memories with memory_save under one name and memory_delete the rest, and drop stale entries.`)
          case 'near':
            return ` The index is at ${size}, near its ${caps} read limit: keep one line per entry, and merge or drop stale entries.`
          default:
            return ''
        }
      }
      try {
        disposers.push(toolCtx.tools.register(defineTool({
          name: SAVE_TOOL_NAME,
          description: 'Save one memory of this project into your own memory store (create it, or update the entry with the same name), and keep its index line current. Use it for facts a future session needs that the repository does not record; never for Claude Code\'s memory, which is read-only.',
          parameters: {
            name: { type: 'string', required: true, description: 'Stable kebab-case id, also the file name without .md; reuse an existing name to update that entry.' },
            type: { type: 'string', required: true, enum: [...MEMORY_TYPES], description: 'user (who the user is, preferences) | feedback (a correction or confirmed approach, with its reason) | project (ongoing work, goals, constraints) | reference (URL, ticket, dashboard).' },
            title: { type: 'string', required: true, description: 'Short title for the index line.' },
            description: { type: 'string', required: true, description: 'One line a later session uses to judge relevance.' },
            hook: { type: 'string', required: true, description: 'The index line\'s one-sentence hook after the title: the fact itself in brief.' },
            content: { type: 'string', required: true, description: 'The memory body in Markdown: the fact with dates in full; for feedback and project, end with **Why:** and **How to apply:** lines; link related memories as [[name]].' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                created: { type: 'boolean', required: true },
                indexLines: { type: 'integer', required: true },
                indexChars: { type: 'integer', required: true },
                indexNote: { type: 'string', required: true },
              },
            },
            render: (args, value) => [{ type: 'text', text: `${value.created ? 'Saved' : 'Updated'} memory ${args.name} at ${value.path}.${value.indexNote}` }],
          },
          isConcurrencySafe: () => false,
          async execute(args, exec) {
            if (!isMemoryName(args.name)) throw new Error(`name must be lower-case kebab-case (letters, digits, single hyphens) and not the reserved "memory", got ${JSON.stringify(args.name)}`)
            for (const field of ['title', 'description', 'hook', 'content']) {
              if (args[field].trim().length === 0) throw new Error(`${field} must not be empty`)
            }
            const dir = await dirOf(exec)
            const saved = await saveMemory(dir, { ...args, sessionId: String(exec.agent.session.id) })
            return { path: saved.path, created: saved.created, indexLines: saved.indexLines, indexChars: saved.indexChars, indexNote: indexVerdict(saved) }
          },
        })))
        disposers.push(toolCtx.tools.register(defineTool({
          name: DELETE_TOOL_NAME,
          description: 'Delete one memory of yours from this project\'s own memory store and drop its index line. Only your own store; Claude Code\'s memory cannot be deleted from here.',
          parameters: {
            name: { type: 'string', required: true, description: 'The memory\'s name as it appears in the index link, without .md.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                existed: { type: 'boolean', required: true },
                indexLines: { type: 'integer', required: true },
              },
            },
            render: (args, value) => [{ type: 'text', text: value.existed ? `Deleted memory ${args.name}.` : `No memory named ${args.name} in ${value.path.slice(0, value.path.lastIndexOf('/'))}; nothing to delete.` }],
          },
          isConcurrencySafe: () => false,
          async execute(args, exec) {
            if (!isEntryName(args.name)) throw new Error(`name must be a file stem as the index links it (letters, digits, dots, hyphens, underscores; no leading dot) and not the reserved "memory", got ${JSON.stringify(args.name)}`)
            const dir = await dirOf(exec)
            const removed = await deleteMemory(dir, args.name)
            return { path: removed.path, existed: removed.removedFile || removed.removedLines > 0, indexLines: removed.indexLines }
          },
        })))
        toolsRegistered = true
      } catch (error) {
        // A name collision on an optional tool must not disable injection,
        // and the tool that did register is withdrawn so the framing stays true.
        for (const dispose of disposers) dispose()
        ctx.logger.warn(`claude-memory: cannot register the memory tools: ${error.message}`)
      }
    })
  }

  // Optional: only a composed command surface can offer the switch. Injection
  // and the mode gate work without it, with every session on the configured
  // default. Older hosts also lack appendPluginRecord; keep injection working
  // and leave the switch out.
  ctx.inject(['commands'], (commandCtx) => {
    if (typeof appendPluginRecord !== 'function') {
      ctx.logger.warn('claude-memory: /memory is unavailable: the host does not export appendPluginRecord')
      return
    }
    try {
      commandCtx.commands.register({
        definitionId: COMMAND_DEFINITION_ID,
        name: COMMAND_NAME,
        description: 'Choose which project memory this session reads',
        input: { hint: `[${SOURCES.join('|')}] on|off | status` },
        handler: ({ agent, rawInput }) => {
          const request = parseMemoryCommand(rawInput)
          if (request === undefined) return { kind: 'error', text: `usage: /memory [${SOURCES.join('|')}] on|off | status` }
          const mode = ctx.sessionProjections.stateOf(agent.session, MODE_PROJECTION_KEY)
          if (mode === undefined) throw new Error('claude-memory requires its mode projection to be registered')
          const read = resolveRead(mode)
          const describe = (ids) => ids.map((id) => `${id} ${read[id] ? 'on' : 'off'}`).join(', ')
          if (request.action === 'status') return { kind: 'success', text: `Memory read: ${describe(sources)}` }
          const unavailable = request.sources.filter((id) => !sources.includes(id))
          if (unavailable.length > 0 && request.sources.length === unavailable.length) return { kind: 'error', text: `memory source ${unavailable.join(', ')} is not configured in this profile` }
          const position = request.enabled ? 'on' : 'off'
          const changing = request.sources.filter((id) => sources.includes(id) && read[id] !== request.enabled)
          if (changing.length === 0) return { kind: 'success', text: `Memory read already ${position}: ${describe(request.sources.filter((id) => sources.includes(id)))}` }
          let seq
          try {
            for (const source of changing) seq = appendPluginRecord(agent.session, MODE_EVENT_TYPE, { source, enabled: request.enabled })
          } catch (error) {
            ctx.logger.warn(`claude-memory: cannot store the memory switch for session ${agent.session.id}: ${error.message}`)
            return { kind: 'error', text: 'could not change the memory switch; the session log rejected the update' }
          }
          return { kind: 'success', text: `Memory read ${position}: ${changing.join(', ')}`, sourceEventSeq: seq }
        },
      })
    } catch (error) {
      // A name collision on the optional command must not disable injection.
      ctx.logger.warn(`claude-memory: cannot register /${COMMAND_NAME}: ${error.message}`)
    }
  })

  const snapshotMessage = (text, path) => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name, text }], path, digest: digestOf(text) },
  })

  const warnOnce = (session, path, line) => {
    let paths = warned.get(session)
    if (paths === undefined) warned.set(session, paths = new Set())
    if (paths.has(path)) return
    paths.add(path)
    ctx.logger.warn(line)
  }

  /**
   * The bounded text of a located index file, from cache when its size and
   * mtime hold (an in-place rewrite that preserves both is not noticed).
   * A read failure is reported as its own kind and never cached: it says
   * nothing about the file's content, so the caller must not withdraw.
   * @returns {Promise<{ kind: 'text', text: string, truncated: boolean } | { kind: 'blank' } | { kind: 'error' }>}
   */
  const currentIndex = async (session, located) => {
    const cached = bounded.get(located.path)
    if (cached !== undefined && cached.size === located.size && cached.mtimeMs === located.mtimeMs) return cached.value
    let index
    try {
      index = await readIndex(located.path, limits)
    } catch (error) {
      warnOnce(session, located.path, `claude-memory: cannot read ${located.path}: ${error.message}`)
      return { kind: 'error' }
    }
    // A blank window of a file that continues past it says nothing about the rest.
    const value = index.text.trim().length === 0 && !index.truncated ? { kind: 'blank' } : { kind: 'text', ...index }
    bounded.set(located.path, { size: located.size, mtimeMs: located.mtimeMs, value })
    return value
  }

  /**
   * The own index as projected from its entry files, bounded like a read
   * index, with the file on disk repaired when it disagrees. The projection
   * is what the model sees, so an index file left behind by an interrupted
   * or overlapping write cannot hide an entry. A repair that fails is warned
   * about once and changes nothing shown; an entry that cannot be read is
   * warned about once and marks the index truncated, since it is missing a
   * line. A projection that fails altogether (the directory or index file is
   * unreadable) is `undefined`, and the section degrades to "not loaded".
   * @param {string} indexPath - the own `MEMORY.md` path.
   * @returns {Promise<{ text: string, truncated: boolean } | undefined>}
   */
  const currentOwnIndex = async (session, indexPath) => {
    const dir = dirname(indexPath)
    let index
    try {
      index = await projectIndex(dir)
      if (index.stale) {
        try {
          await syncIndex(dir)
        } catch (error) {
          warnOnce(session, `${indexPath}#repair`, `claude-memory: cannot rewrite ${indexPath} from its entry files: ${error.message}; the projected index is shown anyway`)
        }
      }
    } catch (error) {
      warnOnce(session, indexPath, `claude-memory: cannot read ${indexPath}: ${error.message}`)
      return undefined
    }
    if (index.skipped.length > 0) {
      warnOnce(session, `${indexPath}#skipped`, `claude-memory: ${index.skipped.length} entry file(s) in ${dir} cannot be read (${index.skipped.map((entry) => `${entry.name}.md: ${entry.error.message}`).join('; ')}); the index shown omits them`)
    }
    const bounded = truncateIndex(index.text, limits)
    return { text: bounded.text, truncated: bounded.truncated || index.skipped.length > 0 }
  }

  /**
   * Locate the stores this session reads and read their indexes. The Claude
   * Code index is located only when its switch is on; when it cannot be
   * inspected or read the whole result is `undefined`, so the turn enters
   * nothing rather than a message missing a section it could not vouch for.
   * The own store, when configured, is always named so the model can write
   * to it; its index is projected from its entry files only when the `dsh`
   * switch is on. An own index that cannot be projected degrades to "not
   * loaded" (the model is told to read it before saving); an own store that cannot be located or inspected
   * marks the result `incomplete`, and the caller then enters nothing, since
   * a message without the own section would read as "not being read".
   * @param {Record<string, boolean>} read - resolved switches.
   * @returns {Promise<{ claude?: { path: string, text: string, truncated: boolean }, own?: { path: string, text?: string, truncated: boolean, loaded: boolean, unwritable?: 'no-tools' | 'read-only' }, incomplete: boolean } | undefined>}
   */
  const currentStores = async (session, cwd, signal, read) => {
    let located
    try {
      located = read.claude ? await locateMemoryIndex(cwd, claudeHome) : undefined
    } catch (error) {
      // The file may exist but cannot be inspected right now; say nothing rather than withdraw.
      warnOnce(session, cwd, `claude-memory: cannot inspect the memory index for ${cwd}: ${error.message}`)
      return undefined
    }
    signal.throwIfAborted()
    const stores = { incomplete: false }
    if (located !== undefined) {
      const index = await currentIndex(session, located)
      if (index.kind === 'error') return undefined
      if (index.kind === 'text') stores.claude = { path: located.path, text: index.text, truncated: index.truncated }
    }
    if (ownMemory) {
      let own
      try {
        own = await locateOwnIndex(cwd, ownMemoryHome, { stat: read.dsh })
      } catch (error) {
        // Without a canonical root or a stat there is no directory to vouch for; leave the section out this turn.
        warnOnce(session, `${cwd}#own`, `claude-memory: cannot inspect the own memory index for ${cwd}: ${error.message}`)
        stores.incomplete = true
      }
      if (own !== undefined) {
        if (!toolsRegistered) warnOnce(session, 'tools', `claude-memory: the host registered no memory tools; session ${session.id} is told its own store cannot be written`)
        const unwritable = !toolsRegistered ? 'no-tools' : readOnly(session) ? 'read-only' : undefined
        stores.own = { path: own.path, truncated: false, loaded: read.dsh, ...(unwritable === undefined ? {} : { unwritable }) }
        if (read.dsh) {
          const index = await currentOwnIndex(session, own.path)
          if (index === undefined) stores.own.loaded = false
          else if (index.text.trim().length > 0 || index.truncated) stores.own = { ...stores.own, text: index.text, truncated: index.truncated, loaded: true }
        }
      }
    }
    signal.throwIfAborted()
    return stores
  }

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    // Only a proceeding first step of a turn carries the index; an empty first
    // entry owns a no-step turn, and later steps are tool continuations.
    if (decision.kind === 'reject' || step !== 1 || decision.messages.length === 0) return decision
    const session = agent.session
    const mode = ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY)
    if (mode === undefined) throw new Error('claude-memory requires its mode projection to be registered')
    const read = resolveRead(mode)
    // Nothing to read and nowhere to write: the turn touches no file.
    if (!read.claude && !ownMemory) return decision
    if (session.header.origin === 'subagent' && !config.includeSubagents) return decision
    const cwd = session.header.cwd
    if (cwd === undefined) return decision
    const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)
    if (state === undefined) throw new Error('claude-memory requires its session projection to be registered')
    const stores = await currentStores(session, cwd, signal, read)
    // A store that could not be inspected would be missing from any message
    // entered now, which the model would read as "not being read"; say nothing.
    if (stores === undefined || stores.incomplete) return decision
    let message
    if (stores.claude === undefined && stores.own === undefined) {
      // Nothing to show: withdraw an index the model has seen, otherwise stay silent.
      if (state.digest === null || state.path === null) return decision
      message = snapshotMessage(renderWithdrawnMessage(state.path), state.path)
    } else {
      message = snapshotMessage(renderMemoryMessage({ ...stores, maxLines: limits.maxLines }), stores.claude?.path ?? stores.own.path)
    }
    if (state.digest === message.source.digest) return decision
    if (decision.messages.some((entry) => entry.source?.kind === SOURCE_KIND && entry.source.digest === message.source.digest)) return decision
    // A switch can land while the indexes are being located and read; re-read
    // them so a turn whose sources changed meanwhile enters nothing stale.
    const latestMode = ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY)
    if (latestMode === undefined) throw new Error('claude-memory requires its mode projection to be registered')
    if (!sameRead(read, resolveRead(latestMode))) return decision
    ctx.logger.info(`claude-memory: entered ${message.source.path} (${Buffer.byteLength(message.content[0].text, 'utf8')} bytes) into session ${session.id}`)
    // Right after the claimed batch: the user's prompt precedes the index and
    // driver-appended runtime context follows it. When an earlier listener
    // replaced the claimed messages by copies, the tail is the safe place.
    const lastClaimedIndex = decision.messages.findLastIndex((entry) => messages.includes(entry))
    const entered = lastClaimedIndex === -1
      ? [...decision.messages, message]
      : decision.messages.toSpliced(lastClaimedIndex + 1, 0, message)
    return { ...decision, messages: entered }
  })
}
