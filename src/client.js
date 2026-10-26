/**
 * Web client half of dsh-claude-memory.
 *
 * The DSH client module system loads this file as a closure factory: the
 * top-level call only registers the factory; the module body runs when the
 * factory materializes. No build step is involved. The plugin registers one
 * composer tool-row control before the model selector: a "Memory" button that
 * opens a menu with one row per memory source from the `claudeMemoryMode`
 * projection view, each row a switch that executes the server command
 * `/memory <source> on|off` for the current session. Rows follow the view, so
 * a source the server adds later appears without a client change.
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
      'button.label': '记忆',
      'button.none': '记忆:关',
      'button.title': '选择本会话读取哪些项目记忆',
      'button.failed': '切换失败',
      'source.claude': 'Claude Code',
      'source.dsh': 'DSH',
      'switch.on': '开',
      'switch.off': '关',
    }
    const en = {
      'button.label': 'Memory',
      'button.none': 'Memory: off',
      'button.title': 'Choose which project memory this session reads',
      'button.failed': 'Switch failed',
      'source.claude': 'Claude Code',
      'source.dsh': 'DSH',
      'switch.on': 'on',
      'switch.off': 'off',
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
    const menuStyle = {
      position: 'absolute',
      bottom: '100%',
      left: 0,
      marginBottom: 4,
      minWidth: 180,
      padding: 4,
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.3))',
      background: 'var(--dsw-alias-bg-elevated, Canvas)',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)',
      zIndex: 10,
    }
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      width: '100%',
      height: 28,
      padding: '0 8px',
      border: 'none',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
      textAlign: 'left',
    }

    /**
     * Composer tool-row menu over the host-computed mode view: one switch per source.
     * @param {{ available: boolean, sessionId: string, useProjection: (key: string) => { sources: { id: string, enabled: boolean }[] } | undefined, toggleMemory: (line: string) => Promise<string | null>, t: (key: string) => string }} props
     */
    function MemoryMenu({ available, sessionId, useProjection, toggleMemory, t }) {
      const mode = useProjection(MODE_KEY)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const alive = React.useRef(true)
      const request = React.useRef(0)
      const sourcesKey = mode === undefined ? '' : mode.sources.map((source) => `${source.id}:${source.enabled}`).join(',')
      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])
      React.useEffect(() => {
        request.current += 1
        setBusy(null)
        setError(null)
      }, [sessionId, sourcesKey])
      React.useEffect(() => {
        setOpen(false)
      }, [sessionId])
      if (!available || mode === undefined) return null
      const enabledNames = mode.sources.filter((source) => source.enabled).map((source) => t(`source.${source.id}`))
      const label = enabledNames.length === 0 ? t('button.none') : `${t('button.label')}: ${enabledNames.join(' + ')}`
      const onSwitch = (source) => {
        if (busy !== null) return
        const token = ++request.current
        setBusy(source.id)
        setError(null)
        void toggleMemory(`/memory ${source.id} ${source.enabled ? 'off' : 'on'}`).then((failure) => {
          if (!alive.current || request.current !== token) return
          setBusy(null)
          if (failure !== null) setError(failure)
        }, (reason) => {
          if (!alive.current || request.current !== token) return
          setBusy(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      const button = React.createElement('button', {
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        title: t('button.title'),
        onClick: () => setOpen(!open),
        style: pillStyle,
      }, label)
      const rows = mode.sources.map((source) => React.createElement('button', {
        key: source.id,
        type: 'button',
        role: 'menuitemcheckbox',
        'aria-checked': source.enabled,
        disabled: busy !== null,
        onClick: () => onSwitch(source),
        style: { ...rowStyle, opacity: busy === source.id ? 0.6 : 1 },
      },
      React.createElement('span', null, t(`source.${source.id}`)),
      React.createElement('span', { style: { opacity: 0.75 } }, t(source.enabled ? 'switch.on' : 'switch.off'))))
      const menu = open ? React.createElement('div', { role: 'menu', style: menuStyle }, ...rows) : null
      const status = error === null
        ? null
        : React.createElement('span', { role: 'status', title: error, style: { fontSize: 12, opacity: 0.75 } }, t('button.failed'))
      return React.createElement('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 } }, button, menu, status)
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
      }, MemoryMenu))
    }

    exports.name = 'claude-memory-ui'
    exports.inject = ['slots', 'remote', 'remote.commands', 'sessions', 'locale']
    exports.apply = apply
    return module.exports
  },
})
