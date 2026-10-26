import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  MEMORY_TYPES, deleteMemory, isMemoryName, removeIndexLine, renderIndexLine, renderMemoryFile, saveMemory, upsertIndexLine,
} from '../src/store.js'
import { Config, DELETE_TOOL_NAME, SAVE_TOOL_NAME, apply } from '../src/index.js'
import { slugOf } from '../src/locate.js'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsh-claude-memory-store-')))

test('memory names are lower-case kebab-case', () => {
  for (const ok of ['a', 'reply-in-chinese', 'dsh-0-2-1']) assert.equal(isMemoryName(ok), true, ok)
  for (const bad of ['', 'Reply', 'a--b', '-a', 'a-', 'a_b', 'a b', 'a/b', '../x', 'a.md', 'x'.repeat(101)]) assert.equal(isMemoryName(bad), false, bad)
  assert.deepEqual([...MEMORY_TYPES], ['user', 'feedback', 'project', 'reference'])
})

test('renderMemoryFile writes Claude Code frontmatter with the host-filled fields and a trimmed body', () => {
  const text = renderMemoryFile({
    name: 'deploy-host', description: 'Where: the deploy box\nis mini', type: 'project', content: '\n部署机是 mini。\n\n**Why:** 只有它有公网。\n', sessionId: 's-1', modified: new Date('2026-10-26T06:00:00Z'),
  })
  assert.equal(text, [
    '---',
    'name: deploy-host',
    'description: "Where: the deploy box is mini"',
    'metadata:',
    '  node_type: memory',
    '  type: project',
    '  originSessionId: s-1',
    '  modified: 2026-10-26T06:00:00.000Z',
    '---',
    '',
    '部署机是 mini。\n\n**Why:** 只有它有公网。',
    '',
  ].join('\n'))
})

test('index lines are upserted by link target and removed by it, keeping the rest byte for byte', () => {
  const line = renderIndexLine({ name: 'deploy-host', title: 'Deploy [host]', hook: 'the box\nis mini' })
  assert.equal(line, '- [Deploy host](deploy-host.md) — the box is mini')
  const fresh = upsertIndexLine('', 'deploy-host', line)
  assert.deepEqual(fresh, { text: `${line}\n`, replaced: false, lines: 1 })
  const existing = '- [Other](other.md) — o\n- [Old](deploy-host.md) — old hook\n- [Dot](deploy-host-2.md) — not the same\n'
  const replaced = upsertIndexLine(existing, 'deploy-host', line)
  assert.deepEqual(replaced, { text: `- [Other](other.md) — o\n${line}\n- [Dot](deploy-host-2.md) — not the same\n`, replaced: true, lines: 3 })
  const appended = upsertIndexLine('- [Other](other.md) — o', 'deploy-host', line)
  assert.equal(appended.text, `- [Other](other.md) — o\n${line}\n`, 'a file without a trailing newline still gets one line per entry')
  const removed = removeIndexLine(replaced.text, 'deploy-host')
  assert.deepEqual(removed, { text: '- [Other](other.md) — o\n- [Dot](deploy-host-2.md) — not the same\n', removed: 1, lines: 2 })
  assert.deepEqual(removeIndexLine('- [Only](only.md) — x\n', 'only'), { text: '', removed: 1, lines: 0 })
  assert.deepEqual(removeIndexLine(existing, 'missing'), { text: existing, removed: 0, lines: 3 })
})

test('saveMemory creates the directory, the file, and the index line; a second save updates both; deleteMemory removes both', async () => {
  const dir = join(scratch(), 'store')
  const first = await saveMemory(dir, { name: 'deploy-host', description: 'd', type: 'project', title: 'Deploy host', hook: 'mini', content: 'body', sessionId: 's-1' })
  assert.equal(first.path, join(dir, 'deploy-host.md'))
  assert.equal(first.created, true)
  assert.equal(first.indexLines, 1)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Deploy host](deploy-host.md) — mini\n')
  assert.match(readFileSync(first.path, 'utf8'), /^---\nname: deploy-host\n/)
  const second = await saveMemory(dir, { name: 'deploy-host', description: 'd2', type: 'project', title: 'Deploy host', hook: 'now the mac', content: 'body 2', sessionId: 's-2' })
  assert.equal(second.created, false)
  assert.equal(second.indexLines, 1)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Deploy host](deploy-host.md) — now the mac\n')
  assert.match(readFileSync(first.path, 'utf8'), /originSessionId: s-2\n/)
  await saveMemory(dir, { name: 'other', description: 'o', type: 'user', title: 'Other', hook: 'o', content: 'o', sessionId: 's-1' })
  assert.deepEqual(readdirSync(dir).sort(), ['MEMORY.md', 'deploy-host.md', 'other.md'], 'no temp file is left behind')
  const removed = await deleteMemory(dir, 'deploy-host')
  assert.deepEqual(removed, { path: first.path, indexPath: join(dir, 'MEMORY.md'), removedFile: true, removedLines: 1, indexLines: 1 })
  assert.equal(existsSync(first.path), false)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Other](other.md) — o\n')
  const again = await deleteMemory(dir, 'deploy-host')
  assert.deepEqual(again, { path: first.path, indexPath: join(dir, 'MEMORY.md'), removedFile: false, removedLines: 0, indexLines: 1 }, 'deleting a missing memory is not an error')
})

test('concurrent saves to one directory all land in the index', async () => {
  const dir = join(scratch(), 'store')
  await Promise.all(Array.from({ length: 8 }, (_, index) => saveMemory(dir, {
    name: `entry-${index}`, description: 'd', type: 'reference', title: `Entry ${index}`, hook: 'h', content: 'c', sessionId: 's',
  })))
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean).length, 8)
})

/** Mount the plugin on a real tool runtime with a real session store, as the host composes them. */
async function mountWithTools(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  apply(ctx, Config(config))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return ctx
}

let calls = 0
const call = (ctx, name, args, agent) => ctx.tools.execute({
  signal: new AbortController().signal, callId: `call-${++calls}`, name, arguments: args, ...(agent === undefined ? {} : { agent }),
})
const text = (result) => result.content.filter((block) => block.type === 'text').map((block) => block.text).join('')

test('memory_save and memory_delete write the calling session\'s own store through the real tool runtime', async () => {
  const ownHome = scratch()
  const project = scratch()
  const ctx = await mountWithTools({ ownMemory: true, ownMemoryHome: ownHome, maxLines: 2 })
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith('memory_')).sort(), [DELETE_TOOL_NAME, SAVE_TOOL_NAME])
  const saveSchema = ctx.tools.schemas().find((schema) => schema.name === SAVE_TOOL_NAME)
  assert.deepEqual(Object.keys(saveSchema.parameters.properties).sort(), ['content', 'description', 'hook', 'name', 'title', 'type'])
  assert.deepEqual(saveSchema.parameters.properties.type.enum, ['user', 'feedback', 'project', 'reference'])

  const session = ctx.sessions.create(SessionId('memory-tool-1'), { meta: { cwd: project } })
  const agent = { id: session.id, session }
  const dir = join(ownHome, slugOf(project))
  const saved = await call(ctx, SAVE_TOOL_NAME, { name: 'deploy-host', type: 'project', title: 'Deploy host', description: 'd', hook: 'mini', content: 'body' }, agent)
  assert.equal(saved.isError, false, JSON.stringify(saved))
  assert.deepEqual(saved.value, { path: join(dir, 'deploy-host.md'), created: true, indexLines: 1 })
  assert.equal(text(saved), `Saved memory deploy-host at ${join(dir, 'deploy-host.md')}.`)
  assert.match(readFileSync(join(dir, 'deploy-host.md'), 'utf8'), /originSessionId: memory-tool-1\n/)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Deploy host](deploy-host.md) — mini\n')

  for (const name of ['two', 'three']) await call(ctx, SAVE_TOOL_NAME, { name, type: 'user', title: name, description: 'd', hook: 'h', content: 'c' }, agent)
  const over = await call(ctx, SAVE_TOOL_NAME, { name: 'four', type: 'user', title: 'four', description: 'd', hook: 'h', content: 'c' }, agent)
  assert.match(text(over), /The index now has 4 lines; only the first 2 are loaded/)

  const badName = await call(ctx, SAVE_TOOL_NAME, { name: 'Bad Name', type: 'user', title: 't', description: 'd', hook: 'h', content: 'c' }, agent)
  assert.equal(badName.isError, true)
  assert.match(text(badName), /kebab-case/)
  const badType = await call(ctx, SAVE_TOOL_NAME, { name: 'ok', type: 'misc', title: 't', description: 'd', hook: 'h', content: 'c' }, agent)
  assert.equal(badType.isError, true, 'the registry enforces the type enum')
  const noAgent = await call(ctx, SAVE_TOOL_NAME, { name: 'ok', type: 'user', title: 't', description: 'd', hook: 'h', content: 'c' })
  assert.equal(noAgent.isError, true)
  assert.match(text(noAgent), /working directory/)

  const removed = await call(ctx, DELETE_TOOL_NAME, { name: 'deploy-host' }, agent)
  assert.equal(removed.isError, false)
  assert.deepEqual(removed.value, { path: join(dir, 'deploy-host.md'), existed: true, indexLines: 3 })
  assert.equal(text(removed), 'Deleted memory deploy-host.')
  assert.equal(existsSync(join(dir, 'deploy-host.md')), false)
  const missing = await call(ctx, DELETE_TOOL_NAME, { name: 'deploy-host' }, agent)
  assert.equal(missing.isError, false)
  assert.equal(missing.value.existed, false)
  assert.match(text(missing), /nothing to delete/)
})

test('the tools write to the main repository\'s store from a linked worktree, and are absent without an own store', async () => {
  const ownHome = scratch()
  const main = scratch()
  mkdirSync(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
  writeFileSync(join(main, '.git', 'worktrees', 'feat', 'commondir'), '../..\n')
  const wt = join(main, '.claude', 'worktrees', 'feat')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  const ctx = await mountWithTools({ ownMemory: true, ownMemoryHome: ownHome })
  const session = ctx.sessions.create(SessionId('memory-tool-wt'), { meta: { cwd: wt } })
  const saved = await call(ctx, SAVE_TOOL_NAME, { name: 'shared', type: 'project', title: 'Shared', description: 'd', hook: 'h', content: 'c' }, { id: session.id, session })
  assert.equal(saved.value.path, join(ownHome, slugOf(main), 'shared.md'))

  const without = await mountWithTools({ ownMemory: false })
  assert.equal(without.tools.schemas().some((schema) => schema.name.startsWith('memory_')), false)
})
