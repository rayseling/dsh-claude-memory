/**
 * dsh-claude-memory — give a DeepSeek Harness session the Claude Code memory of
 * the project it works in, the way Claude Code loads it itself.
 *
 * At the first step of every turn the plugin locates the project's
 * `MEMORY.md` (see `./locate.js`), bounds it to Claude Code's own index cap,
 * and enters it as one `user`-role message with a producer-owned source
 * (`plugin:claude-memory`, form `snapshot`). The message is an ordinary
 * `user/message` session event, so it replays, compacts, and resumes like the
 * rest of the history and the model-visible state stays reconstructable from
 * the log. A digest in the source keeps the index from entering twice: a turn
 * whose newest visible snapshot already carries the current digest adds
 * nothing, and a changed index enters as a newer snapshot that supersedes it.
 *
 * Topic files are not loaded: the framing tells the model to `cat` one only
 * when the task relates to it, which is Claude Code's on-demand rule.
 * Subagent sessions get nothing by default, as in Claude Code.
 * @module dsh-claude-memory
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { locateMemoryIndex, renderIndexMessage, truncateIndex } from './locate.js'

/** Stable Cordis plugin name. */
export const name = 'claude-memory'

/** No service is required: the plugin reads the agent's session and the local filesystem only. */
export const inject = []

/** Producer-owned source kind of every message this plugin enters. */
export const SOURCE_KIND = `plugin:${name}`

/** Plugin configuration; every field has Claude Code's own value as default. */
export const Config = z.object({
  /** Claude Code configuration directory holding `projects/`. A leading `~/` expands to the home directory. */
  claudeHome: z.string().default(join(homedir(), '.claude')),
  /** Maximum index lines entered, as Claude Code caps its own load. */
  maxLines: z.number().step(1).min(1).default(200),
  /** Maximum index bytes entered, as Claude Code caps its own load. */
  maxBytes: z.number().step(1).min(1).default(25 * 1024),
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
 * Whether the current index is already the newest memory snapshot the model
 * sees: in this step's batch, or as the latest `plugin:claude-memory` message
 * in the session surface.
 * @param {object} session - the agent's session.
 * @param {readonly object[]} batch - messages the step is about to enter.
 * @param {string} digest - digest of the rendered index.
 * @returns {boolean} true when entering the index again would duplicate it.
 */
function alreadyVisible(session, batch, digest) {
  const matches = (message) => message?.source?.kind === SOURCE_KIND && message.source.digest === digest
  if (batch.some(matches)) return true
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index])
    if (event?.type !== 'user/message' || event.data?.source?.kind !== SOURCE_KIND) continue
    return event.data.source.digest === digest
  }
  return false
}

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context.
 * @param {z.infer<typeof Config>} config - validated configuration.
 */
export function apply(ctx, config) {
  const claudeHome = expandHome(config.claudeHome)
  const limits = { maxLines: config.maxLines, maxBytes: config.maxBytes }

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    // Only a proceeding first step of a turn carries the index; an empty first
    // entry owns a no-step turn, and later steps are tool continuations.
    if (decision.kind === 'reject' || step !== 1 || decision.messages.length === 0) return decision
    const session = agent.session
    if (session.header.origin === 'subagent' && !config.includeSubagents) return decision
    const located = locateMemoryIndex(session.header.cwd ?? process.cwd(), claudeHome)
    if (located === undefined) return decision
    let raw
    try {
      raw = await readFile(located.path, 'utf8')
    } catch (error) {
      ctx.logger.warn(`claude-memory: cannot read ${located.path}: ${error.message}`)
      return decision
    }
    signal.throwIfAborted()
    const index = truncateIndex(raw, limits)
    if (index.text.trim().length === 0) return decision
    const text = renderIndexMessage({ path: located.path, ...index })
    const digest = createHash('sha256').update(text).digest('hex')
    if (alreadyVisible(session, decision.messages, digest)) return decision
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: SOURCE_KIND,
        form: 'snapshot',
        sections: [{ name, text }],
        path: located.path,
        digest,
      },
    })
    ctx.logger.info(`claude-memory: entered ${located.path} (${Buffer.byteLength(text, 'utf8')} bytes) into session ${session.id}`)
    // Right after the claimed batch: the user's prompt precedes the index and
    // driver-appended runtime context follows it.
    const lastClaimedIndex = decision.messages.findLastIndex((entry) => messages.includes(entry))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, message) }
  })
}
