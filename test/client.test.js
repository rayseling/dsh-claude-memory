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
  const view = (sources) => () => ({ sources })

  // The fake useState never re-renders, so the menu is tested closed (the
  // button) and open (rows) by rendering twice with a stateful useState.
  const closed = registration.component({
    available: true, sessionId: 'session-1', useProjection: view([{ id: 'claude', enabled: false }, { id: 'dsh', enabled: true }]), toggleMemory: toggle, t,
  })
  assert.equal(closed.type, 'span')
  const [button, menu] = closed.props.children
  assert.equal(button.type, 'button')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.props.children, 'button.label: source.dsh', 'the label names the sources being read')
  assert.equal(menu, null)

  const none = registration.component({
    available: true, sessionId: 'session-1', useProjection: view([{ id: 'claude', enabled: false }, { id: 'dsh', enabled: false }]), toggleMemory: toggle, t,
  })
  assert.equal(none.props.children[0].props.children, 'button.none')

  const openReact = { ...React, useState(initial) { return [typeof initial === 'boolean' ? true : initial, () => {}] } }
  let openExports
  globalThis.window = { __ModuleLoader__: { load({ factory }) { openExports = factory(() => openReact) } } }
  await import('../src/client.js?open')
  delete globalThis.window
  let openRegistration
  openExports.apply({ ...ctx, slots: { inject: (_name, fn) => fn(), register(definition, component) { openRegistration = { definition, component }; return () => {} } } })
  const opened = openRegistration.component({
    available: true, sessionId: 'session-1', useProjection: view([{ id: 'claude', enabled: false }, { id: 'dsh', enabled: true }, { id: 'future', enabled: true }]), toggleMemory: toggle, t,
  })
  const openMenu = opened.props.children[1]
  assert.equal(openMenu.props.role, 'menu')
  const rows = openMenu.props.children
  assert.deepEqual(rows.map((row) => row.props.key), ['claude', 'dsh', 'future'], 'one row per source in the view, unknown ids included')
  assert.deepEqual(rows.map((row) => row.props['aria-checked']), [false, true, true])
  assert.equal(rows[0].props.children[0].props.children, 'source.claude')
  assert.equal(rows[1].props.children[1].props.children, 'switch.on')
  rows[0].props.onClick()
  await Promise.resolve()
  assert.equal(commands.at(-1), '/memory claude on')
  rows[1].props.onClick()
  await Promise.resolve()
  assert.equal(commands.at(-1), '/memory dsh off')

  assert.equal(registration.component({
    available: true, sessionId: 'session-1', useProjection: () => undefined, toggleMemory: toggle, t,
  }), null)
  assert.equal(registration.component({
    available: false, sessionId: 'session-2', useProjection: view([{ id: 'dsh', enabled: true }]), toggleMemory: toggle, t,
  }), null)
})
