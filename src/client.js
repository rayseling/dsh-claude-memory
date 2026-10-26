/**
 * Web client half of dsh-claude-memory.
 *
 * The DSH client module system loads this file as a closure factory: the
 * top-level call only registers the factory; the module body runs when the
 * factory materializes. No build step is involved. The plugin registers one
 * composer tool-row pill before the model selector over the `claudeMemoryMode`
 * projection and executes the server command `/memory on|off` for the current
 * session.
 */

window.__ModuleLoader__.load({
  id: 'dsh-claude-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const MODE_KEY = 'claudeMemoryMode'
    const COMMAND_NAME = 'memory'
    const COMMAND_DEFINITION_ID = 'dsh-claude-memory'
    const NS = 'claude-memory'
    const zh = {
      'button.on': '记忆:开',
      'button.off': '记忆:关',
      'button.busy': '切换中…',
      'button.title': '切换本会话的项目记忆',
      'button.failed': '切换失败',
    }
    const en = {
      'button.on': 'Memory: on',
      'button.off': 'Memory: off',
      'button.busy': 'Switching…',
      'button.title': 'Toggle project memory for this session',
      'button.failed': 'Switch failed',
    }
    const pillStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      height: 28,
      padding: '0 8px',
      border: 'none',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    }

    /**
     * Composer tool-row switch over the host-computed mode view.
     * @param {{ available: boolean, sessionId: string, useProjection: (key: string) => { enabled: boolean } | undefined, toggleMemory: (line: string) => Promise<string | null>, t: (key: string) => string }} props
     */
    function MemoryPill({ available, sessionId, useProjection, toggleMemory, t }) {
      const mode = useProjection(MODE_KEY)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [hover, setHover] = React.useState(false)
      const alive = React.useRef(true)
      const request = React.useRef(0)
      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])
      React.useEffect(() => {
        request.current += 1
        setBusy(false)
        setError(null)
      }, [sessionId, mode?.enabled])
      if (!available || mode === undefined) return null
      const enabled = mode.enabled !== false
      const label = busy ? t('button.busy') : enabled ? t('button.on') : t('button.off')
      const onClick = () => {
        if (busy) return
        const token = ++request.current
        setBusy(true)
        setError(null)
        void toggleMemory(enabled ? '/memory off' : '/memory on').then((failure) => {
          if (!alive.current || request.current !== token) return
          setBusy(false)
          if (failure !== null) setError(failure)
        }, (reason) => {
          if (!alive.current || request.current !== token) return
          setBusy(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      const button = React.createElement('button', {
        type: 'button',
        'aria-pressed': enabled,
        title: t('button.title'),
        disabled: busy,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          ...pillStyle,
          background: hover && !busy ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
          opacity: busy ? 0.6 : 1,
        },
      }, label)
      if (error === null) return button
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        button,
        React.createElement('span', { role: 'status', title: error, style: { fontSize: 12, opacity: 0.75 } }, t('button.failed')))
    }

    /**
     * Mount the client half.
     * @param {object} ctx - client Cordis context with slots, remote.commands, sessions, and locale.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'claude-memory: dictionaries')
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'memory',
        order: 0,
        locale: NS,
        inject: (sessionId) => ({
          available: ctx.sessions.subagentAddress(sessionId) === undefined,
          sessionId,
          toggleMemory: async (line) => {
            const catalog = await ctx.remote.commands.list(sessionId)
            if (!catalog.ok) return `${catalog.error.message} (${catalog.error.code})`
            const descriptor = catalog.value.find((entry) => entry.name === COMMAND_NAME)
            if (descriptor?.definitionId !== COMMAND_DEFINITION_ID) return `/${COMMAND_NAME} is not available for this plugin`
            const result = await ctx.remote.commands.execute(sessionId, line, [])
            if (!result.ok) return `${result.error.message} (${result.error.code})`
            if (result.value === undefined) return `unknown command: ${line}`
            if (result.value.result?.kind === 'error') return result.value.result.text ?? `command failed: ${line}`
            return null
          },
        }),
      }, MemoryPill))
    }

    exports.name = 'claude-memory-ui'
    exports.inject = ['slots', 'remote', 'remote.commands', 'sessions', 'locale']
    exports.apply = apply
    return module.exports
  },
})
