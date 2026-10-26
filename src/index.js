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
 * A second projection (`claudeMemoryMode`) holds the per-session on/off
 * switch. A session that never ran `/memory on|off` sits on the configured
 * `enabledByDefault` (off unless the profile says otherwise); the command
 * appends one ignorable `plugin:claude-memory/mode` record per accepted
 * switch. While the switch is off, a turn reads no memory file and enters
 * nothing. The switch is independent of the snapshot state, so a surface
 * replacement cannot change it, and it persists across resume. Turning it off
 * never removes an index already shown to the model.
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
import * as dshSession from '@deepseek-ai/dsh-session'
import { locateMemoryIndex, readIndex, renderIndexMessage, renderWithdrawnMessage } from './locate.js'

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

/** Session projection key holding the per-session on/off switch. */
export const MODE_PROJECTION_KEY = 'claudeMemoryMode'

/** Slash command name that toggles the switch. */
export const COMMAND_NAME = 'memory'

/** Stable command identity the client verifies before dispatching `/memory`. */
export const COMMAND_DEFINITION_ID = 'dsh-claude-memory'

/** Ignorable plugin-record type holding each accepted switch. */
export const MODE_EVENT_TYPE = 'plugin:claude-memory/mode'

/** Plugin configuration; every field but `enabledByDefault` has Claude Code's own value as default. */
export const Config = z.object({
  /** Claude Code configuration directory holding `projects/`. A leading `~/` expands to the home directory. */
  claudeHome: z.string().default(join(homedir(), '.claude')),
  /** Maximum index lines entered, as Claude Code caps its own load. */
  maxLines: z.number().step(1).min(1).default(200),
  /** Maximum index UTF-16 code units entered, as Claude Code caps its own load. */
  maxChars: z.number().step(1).min(1).default(25_000),
  /** Enter memory into sessions a subagent owns; Claude Code gives subagents none. */
  includeSubagents: z.boolean().default(false),
  /** Switch position of a session that never ran `/memory on|off`. Claude Code always loads; this plugin waits to be asked. */
  enabledByDefault: z.boolean().default(false),
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
 * Parse the `/memory` argument grammar. An empty argument asks for status.
 * @param {string} rawInput - text after the command name.
 * @returns {'on' | 'off' | 'status' | undefined} the requested action, or undefined for an unknown argument.
 */
export function parseMemoryCommand(rawInput) {
  const action = rawInput.trim().toLowerCase()
  if (action === '') return 'status'
  return action === 'on' || action === 'off' || action === 'status' ? action : undefined
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
 * Validator for the persisted on/off switch (plain JSON). `null` records that
 * the session never ran `/memory on|off`, so `enabledByDefault` decides; the
 * default lives in configuration, not in the state, so a changed default
 * reaches every undecided session without touching stored checkpoints.
 * @type {{ parse(value: unknown): { enabled: boolean | null } }}
 */
export const modeStateSchema = {
  parse(value) {
    const ok = value !== null && typeof value === 'object' && (value.enabled === null || typeof value.enabled === 'boolean')
    if (!ok) throw new TypeError(`claude-memory: invalid mode state ${JSON.stringify(value)}`)
    return { enabled: value.enabled }
  },
}

/**
 * Validator for the client view of the switch: the resolved position only.
 * @type {{ parse(value: unknown): { enabled: boolean } }}
 */
export const modeViewSchema = {
  parse(value) {
    const ok = value !== null && typeof value === 'object' && typeof value.enabled === 'boolean'
    if (!ok) throw new TypeError(`claude-memory: invalid mode view ${JSON.stringify(value)}`)
    return { enabled: value.enabled }
  },
}

/** Mode state for a session that has not run `/memory on|off`. */
export const MODE_UNSET = Object.freeze({ enabled: null })

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
 * Pure fold for the per-session switch. The command appends one ignorable
 * `MODE_EVENT_TYPE` record per accepted switch; surface replacements and
 * every other event leave the switch alone, so compaction cannot reset it.
 * @param {{ enabled: boolean | null }} state - prior state.
 * @param {object} event - committed session event.
 * @returns {{ enabled: boolean | null }} next state (same reference when unchanged).
 */
export function applyModeProjection(state, event) {
  if (event.type !== MODE_EVENT_TYPE) return state
  const enabled = event.data?.enabled
  if (typeof enabled !== 'boolean' || enabled === state.enabled) return state
  return { enabled }
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
    stateVersion: 2,
    stateSchema: projectionStateSchema,
    init: () => EMPTY_STATE,
    apply: applyProjection,
  })

  /** The switch position a session is in: its own choice, else the configured default. */
  const isEnabled = (mode) => mode.enabled ?? config.enabledByDefault

  ctx.sessionProjections.register({
    key: MODE_PROJECTION_KEY,
    stateVersion: 2,
    stateSchema: modeStateSchema,
    init: () => MODE_UNSET,
    apply: applyModeProjection,
    // Client view: the composer pill reads the resolved switch without knowing the default.
    wire: { viewSchema: modeViewSchema, view: (state) => ({ enabled: isEnabled(state) }) },
  })

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
        description: 'Turn Claude Code memory on or off for this session',
        input: { hint: 'on|off|status' },
        handler: ({ agent, rawInput }) => {
          const action = parseMemoryCommand(rawInput)
          if (action === undefined) return { kind: 'error', text: 'usage: /memory on|off|status' }
          const mode = ctx.sessionProjections.stateOf(agent.session, MODE_PROJECTION_KEY)
          if (mode === undefined) throw new Error('claude-memory requires its mode projection to be registered')
          if (action === 'status') return { kind: 'success', text: `Claude Code memory is ${isEnabled(mode) ? 'on' : 'off'}` }
          const enabled = action === 'on'
          if (isEnabled(mode) === enabled) return { kind: 'success', text: `Claude Code memory is already ${action}` }
          let seq
          try {
            seq = appendPluginRecord(agent.session, MODE_EVENT_TYPE, { enabled })
          } catch (error) {
            ctx.logger.warn(`claude-memory: cannot store the memory switch for session ${agent.session.id}: ${error.message}`)
            return { kind: 'error', text: 'could not change the Claude Code memory switch; the session log rejected the update' }
          }
          return { kind: 'success', text: `Claude Code memory ${action}`, sourceEventSeq: seq }
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
   * The current index message for a located file, from cache when its size
   * and mtime hold (an in-place rewrite that preserves both is not noticed).
   * A read failure is reported as its own kind and never cached: it says
   * nothing about the file's content, so the caller must not withdraw.
   * @returns {Promise<{ kind: 'text', text: string, digest: string } | { kind: 'blank' } | { kind: 'error' }>}
   */
  const currentIndex = async (session, located) => {
    const cached = rendered.get(located.path)
    if (cached !== undefined && cached.size === located.size && cached.mtimeMs === located.mtimeMs) return cached.value
    let index
    try {
      index = await readIndex(located.path, limits)
    } catch (error) {
      warnOnce(session, located.path, `claude-memory: cannot read ${located.path}: ${error.message}`)
      return { kind: 'error' }
    }
    let value
    if (index.text.trim().length === 0) {
      value = { kind: 'blank' }
    } else {
      const text = renderIndexMessage({ path: located.path, ...index })
      value = { kind: 'text', text, digest: digestOf(text) }
    }
    rendered.set(located.path, { size: located.size, mtimeMs: located.mtimeMs, value })
    return value
  }

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    // Only a proceeding first step of a turn carries the index; an empty first
    // entry owns a no-step turn, and later steps are tool continuations.
    if (decision.kind === 'reject' || step !== 1 || decision.messages.length === 0) return decision
    const session = agent.session
    const mode = ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY)
    if (mode === undefined) throw new Error('claude-memory requires its mode projection to be registered')
    if (!isEnabled(mode)) return decision
    if (session.header.origin === 'subagent' && !config.includeSubagents) return decision
    const cwd = session.header.cwd
    if (cwd === undefined) return decision
    const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)
    if (state === undefined) throw new Error('claude-memory requires its session projection to be registered')
    let located
    try {
      located = await locateMemoryIndex(cwd, claudeHome)
    } catch (error) {
      // The file may exist but cannot be inspected right now; say nothing rather than withdraw.
      warnOnce(session, cwd, `claude-memory: cannot inspect the memory index for ${cwd}: ${error.message}`)
      return decision
    }
    signal.throwIfAborted()
    let message
    if (located === undefined) {
      if (state.digest === null || state.path === null) return decision
      message = snapshotMessage(renderWithdrawnMessage(state.path), state.path)
    } else {
      const index = await currentIndex(session, located)
      signal.throwIfAborted()
      if (index.kind === 'error') return decision
      if (index.kind === 'blank') {
        if (state.digest === null) return decision
        message = snapshotMessage(renderWithdrawnMessage(located.path), located.path)
      } else {
        if (state.digest === index.digest) return decision
        message = snapshotMessage(index.text, located.path)
      }
    }
    if (state.digest === message.source.digest) return decision
    if (decision.messages.some((entry) => entry.source?.kind === SOURCE_KIND && entry.source.digest === message.source.digest)) return decision
    // A switch can land while the index is being located and read; re-read it
    // so a turn that has since been switched off enters nothing.
    const latestMode = ctx.sessionProjections.stateOf(session, MODE_PROJECTION_KEY)
    if (latestMode === undefined) throw new Error('claude-memory requires its mode projection to be registered')
    if (!isEnabled(latestMode)) return decision
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
