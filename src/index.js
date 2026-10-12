/**
 * dsh-claude-memory — give a DeepSeek Harness session the Claude Code memory of
 * the project it works in, the way Claude Code loads it itself.
 *
 * At the first step of every turn the plugin locates the project's
 * `MEMORY.md` (see `./locate.js`), reads it within Claude Code's own index
 * cap, and enters it as one `user`-role message with a producer-owned source
 * (`plugin:claude-memory`, form `snapshot`). The message is an ordinary
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
 * Topic files are not loaded: the framing tells the model to `cat` one only
 * when the task relates to it, which is Claude Code's on-demand rule.
 * Subagent sessions get nothing by default, as in Claude Code. A session
 * without a recorded working directory gets nothing: there is no project to
 * attribute memory to, and the process directory would be another project's.
 * @module dsh-claude-memory
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { locateMemoryIndex, readIndex, renderIndexMessage, renderWithdrawnMessage } from './locate.js'

/** Stable Cordis plugin name. */
export const name = 'claude-memory'

/** The projection registry is required: it holds the per-session dedup state. */
export const inject = ['sessionProjections']

/** Producer-owned source kind of every message this plugin enters. */
export const SOURCE_KIND = `plugin:${name}`

/** Session projection key owned by this plugin. */
export const PROJECTION_KEY = 'claudeMemory'

/** Plugin configuration; every field has Claude Code's own value as default. */
export const Config = z.object({
  /** Claude Code configuration directory holding `projects/`. A leading `~/` expands to the home directory. */
  claudeHome: z.string().default(join(homedir(), '.claude')),
  /** Maximum index lines entered, as Claude Code caps its own load. */
  maxLines: z.number().step(1).min(1).default(200),
  /** Maximum index UTF-16 code units entered, as Claude Code caps its own load. */
  maxChars: z.number().step(1).min(1).default(25_000),
  /** Enter memory into sessions a subagent owns; Claude Code gives subagents none. */
  includeSubagents: z.boolean().default(false),
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
 * Validator for the persisted projection state (plain JSON).
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
 * Pure fold: the newest snapshot of this plugin still on the surface.
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
  const op = event.surfaceOp
  if (state.seq !== null && op !== undefined && op !== 'append' && op.op === 'replace' && op.startSeq <= state.seq && state.seq <= op.endSeq) {
    return EMPTY_STATE
  }
  return state
}

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context with `sessionProjections`.
 * @param {z.infer<typeof Config>} config - validated configuration.
 */
export function apply(ctx, config) {
  const claudeHome = expandHome(config.claudeHome)
  const limits = { maxLines: config.maxLines, maxChars: config.maxChars }
  /** Rendered index per path, reused while the file's size and mtime hold. */
  const rendered = new Map()
  /** Paths already warned about per session, so a persistent read failure logs once. */
  const warned = new WeakMap()

  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: projectionStateSchema,
    init: () => EMPTY_STATE,
    apply: applyProjection,
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
   * The current index message for a located file, from cache when unchanged.
   * @returns {Promise<{ text: string, digest: string } | undefined>} undefined for a blank index.
   */
  const currentIndex = async (session, located) => {
    const cached = rendered.get(located.path)
    if (cached !== undefined && cached.size === located.size && cached.mtimeMs === located.mtimeMs) return cached.value
    let index
    try {
      index = await readIndex(located.path, limits)
    } catch (error) {
      warnOnce(session, located.path, `claude-memory: cannot read ${located.path}: ${error.message}`)
      return undefined
    }
    const value = index.text.trim().length === 0
      ? undefined
      : { text: renderIndexMessage({ path: located.path, ...index }) }
    if (value !== undefined) value.digest = digestOf(value.text)
    rendered.set(located.path, { size: located.size, mtimeMs: located.mtimeMs, value })
    return value
  }

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    // Only a proceeding first step of a turn carries the index; an empty first
    // entry owns a no-step turn, and later steps are tool continuations.
    if (decision.kind === 'reject' || step !== 1 || decision.messages.length === 0) return decision
    const session = agent.session
    if (session.header.origin === 'subagent' && !config.includeSubagents) return decision
    const cwd = session.header.cwd
    if (cwd === undefined) return decision
    const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)
    if (state === undefined) throw new Error('claude-memory requires its session projection to be registered')
    const located = await locateMemoryIndex(cwd, claudeHome)
    signal.throwIfAborted()
    let message
    if (located === undefined) {
      if (state.digest === null || state.path === null) return decision
      message = snapshotMessage(renderWithdrawnMessage(state.path), state.path)
    } else {
      const index = await currentIndex(session, located)
      signal.throwIfAborted()
      if (index === undefined) {
        if (state.digest === null) return decision
        message = snapshotMessage(renderWithdrawnMessage(located.path), located.path)
      } else {
        if (state.digest === index.digest) return decision
        message = snapshotMessage(index.text, located.path)
      }
    }
    if (state.digest === message.source.digest) return decision
    if (decision.messages.some((entry) => entry.source?.kind === SOURCE_KIND && entry.source.digest === message.source.digest)) return decision
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
