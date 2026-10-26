import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COMMAND_DEFINITION_ID } from '../src/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...(props ?? {}),
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }
  },
  useState(initial) { return [initial, () => {}] },
  useRef(initial) { return { current: initial } },
  useEffect(fn) { fn(); return () => {} },
}

let loaderId
let clientExports
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaderId = id
      clientExports = factory((specifier) => {
        assert.equal(specifier, 'react')
        return React
      })
    },
  },
}
await import('../src/client.js')
delete globalThis.window

test('client bundle registers the model-row pill and executes /memory', async () => {
  assert.equal(loaderId, pkg.name)
  assert.equal(clientExports.name, 'claude-memory-ui')
  assert.deepEqual(clientExports.inject, ['slots', 'remote', 'remote.commands', 'sessions', 'locale'])

  let dictionaries
  let registration
  let commands = []
  let listed = []
  let reply = { ok: true, value: { result: { kind: 'success' } } }
  let catalog = { ok: true, value: [{ name: 'memory', definitionId: COMMAND_DEFINITION_ID }] }
  const ctx = {
    effect(fn) { fn(); return () => {} },
    locale: {
      register(namespace, dictionary) { dictionaries = { namespace, dictionary } },
    },
    sessions: {
      subagentAddress: () => undefined,
    },
    slots: {
      inject(name, fn) {
        assert.equal(name, 'conversation.input.right')
        return fn()
      },
      register(definition, component) {
        registration = { definition, component }
        return () => {}
      },
    },
    remote: {
      commands: {
        async list(sessionId) {
          listed.push(sessionId)
          return catalog
        },
        async execute(...args) {
          commands.push(args)
          return reply
        },
      },
    },
  }

  clientExports.apply(ctx)
  assert.equal(dictionaries.namespace, 'claude-memory')
  assert.equal(registration.definition.name, 'conversation.input.right')
  assert.equal(registration.definition.id, 'memory')
  assert.equal(registration.definition.locale, 'claude-memory')

  const injected = registration.definition.inject('session-1')
  assert.equal(injected.available, true)
  assert.equal(injected.sessionId, 'session-1')
  assert.equal(await injected.toggleMemory('/memory off'), null)
  assert.deepEqual(commands, [['session-1', '/memory off', []]])
  assert.deepEqual(listed, ['session-1'])

  catalog = { ok: true, value: [{ name: 'memory', definitionId: 'someone-else' }] }
  assert.equal(await injected.toggleMemory('/memory off'), '/memory is not available for this plugin')
  assert.equal(commands.length, 1)
  catalog = { ok: true, value: [] }
  assert.equal(await injected.toggleMemory('/memory off'), '/memory is not available for this plugin')
  catalog = { ok: false, error: { message: 'catalog down', code: 'C' } }
  assert.equal(await injected.toggleMemory('/memory off'), 'catalog down (C)')
  catalog = { ok: true, value: [{ name: 'memory', definitionId: COMMAND_DEFINITION_ID }] }

  reply = { ok: false, error: { message: 'no', code: 'E' } }
  assert.equal(await injected.toggleMemory('/memory off'), 'no (E)')
  reply = { ok: true, value: undefined }
  assert.equal(await injected.toggleMemory('/memory off'), 'unknown command: /memory off')
  reply = { ok: true, value: { result: { kind: 'error', text: 'rejected' } } }
  assert.equal(await injected.toggleMemory('/memory off'), 'rejected')

  ctx.sessions.subagentAddress = () => ({ parentSessionId: 'parent' })
  assert.equal(registration.definition.inject('session-2').available, false)

  const t = (key) => key
  const toggle = (line) => {
    commands.push(line)
    return Promise.resolve(null)
  }
  const off = registration.component({
    available: true, sessionId: 'session-1', useProjection: () => ({ enabled: false }), toggleMemory: toggle, t,
  })
  assert.equal(off.type, 'button')
  assert.equal(off.props['aria-pressed'], false)
  assert.equal(off.props.children, 'button.off')
  off.props.onClick()
  await Promise.resolve()
  assert.equal(commands.at(-1), '/memory on')

  const on = registration.component({
    available: true, sessionId: 'session-1', useProjection: () => ({ enabled: true }), toggleMemory: toggle, t,
  })
  assert.equal(on.props['aria-pressed'], true)
  assert.equal(on.props.children, 'button.on')
  on.props.onClick()
  await Promise.resolve()
  assert.equal(commands.at(-1), '/memory off')

  assert.equal(registration.component({
    available: true, sessionId: 'session-1', useProjection: () => undefined, toggleMemory: toggle, t,
  }), null)
  assert.equal(registration.component({
    available: false, sessionId: 'session-2', useProjection: () => ({ enabled: true }), toggleMemory: toggle, t,
  }), null)
})
