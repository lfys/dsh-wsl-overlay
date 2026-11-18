// dsh-wsl-overlay, browser half.
//
// A PLAIN hand-written bundle, exactly like the ones DSH ships: no build step,
// no `import`/`export` keywords, no JSX. The page loads it as a script, the
// module loader hands it a `require`, and the only module it asks for is React.
//
// What it contributes:
//   - one rail entry in the left sidebar (`sidebar.panellist`), and
//   - the panel behind that entry (`main`, keyed under the same id):
//     WSL status at a glance and a small form that registers a Linux directory
//     as a harness workspace through this plugin's loopback API — the same
//     registry the workspace picker reads, so no second store exists.
//
// Layout facts (verified against the shipped client and dsh-wsl-tool):
//   - `sidebar.panellist` entries carry `id`, `order`, `label`, and render
//     their own icon; `main` is keyed by that same id.
//   - Both seats are registered from the innermost callback so the rail entry
//     and its panel appear together or not at all.

window.__ModuleLoader__.load({
  id: 'dsh-wsl-overlay',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const PANEL_ID = 'dsh-wsl-overlay'
    const API = '/dsh-wsl-overlay/api'

    // -- data ---------------------------------------------------------------

    async function apiGet(path) {
      const reply = await fetch(API + path)
      if (!reply.ok) throw new Error('HTTP ' + reply.status)
      return reply.json()
    }

    async function apiPost(path, body) {
      const reply = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const doc = await reply.json().catch(() => ({}))
      if (!reply.ok) throw new Error(doc.error || 'HTTP ' + reply.status)
      return doc
    }

    // -- pieces ---------------------------------------------------------------

    const STYLES = {
      panel: { padding: '12px 14px', fontSize: '12px', lineHeight: 1.5, overflowY: 'auto', height: '100%', boxSizing: 'border-box' },
      sectionTitle: { margin: '14px 0 6px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6 },
      row: { display: 'flex', alignItems: 'center', gap: '6px', margin: '4px 0' },
      subtle: { opacity: 0.6 },
      input: { flex: 1, minWidth: 0, fontSize: '12px', padding: '4px 6px', boxSizing: 'border-box' },
      button: { fontSize: '12px', padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' },
      msgOk: { margin: '8px 0 0', color: '#3fb26f', wordBreak: 'break-all' },
      msgErr: { margin: '8px 0 0', color: '#e05555', wordBreak: 'break-all' },
      code: { fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all' },
    }

    /** 18×18 terminal-window glyph in `currentColor`, so the layout's
     *  selected/hover colours come through untouched. */
    function WslIcon() {
      return React.createElement(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 20 20',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('rect', { x: 2.5, y: 3.5, width: 15, height: 13, rx: 1.5 }),
        React.createElement('path', { d: 'M2.5 6.5h15' }),
        React.createElement('path', { d: 'M5.5 10l2 2-2 2' }),
        React.createElement('path', { d: 'M9.5 14h5' }),
      )
    }

    function StatusLine(props) {
      const { label, value } = props
      return React.createElement(
        'div',
        { style: STYLES.row },
        React.createElement('span', { style: STYLES.subtle }, label),
        React.createElement('span', null, value),
      )
    }

    function WslPanel() {
      const [status, setStatus] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [distro, setDistro] = React.useState('')
      const [path, setPath] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          const doc = await apiGet('/status')
          setStatus(doc)
          setLoadError(null)
        } catch (error) {
          setLoadError(String(error.message || error))
        }
      }, [])

      React.useEffect(() => {
        let live = true
        refresh().then(() => {
          if (!live) return
          apiGet('/listDistros')
            .then((doc) => {
              const names = (doc.distros || []).map((d) => d.name)
              setDistro((current) => current || names[0] || '')
            })
            .catch(() => {})
        })
        return () => {
          live = false
        }
      }, [refresh])

      const create = async () => {
        const target = path.trim()
        if (!target) return setMsg({ ok: false, text: '请填写 Linux 路径，例如 /home/you/project' })
        const posix = target.replace(/\/+$/, '') || '/'
        if (posix === '/mnt' || posix.indexOf('/mnt/') === 0) {
          return setMsg({ ok: false, text: '/mnt 不能作为工作区根：Windows 侧解析不了 /mnt 之下任何路径，请把项目放到 /home 下' })
        }
        setBusy(true)
        setMsg(null)
        try {
          const doc = await apiPost('/createWorkspace', { path: posix, distro })
          setMsg({ ok: true, text: '已注册工作区：' + (doc.title || doc.path) })
          setPath('')
          refresh()
        } catch (error) {
          const hint = /ENOENT|realpath/i.test(String(error.message))
            ? String(error.message) + ' —— 目录不存在？先在发行版里 mkdir -p，再注册'
            : String(error.message || error)
          setMsg({ ok: false, text: hint })
        } finally {
          setBusy(false)
        }
      }

      const distroNames = (status && status.distros) || []
      const variants = (status && status.variants) || []

      return React.createElement(
        'div',
        { style: STYLES.panel },
        React.createElement('div', { style: STYLES.sectionTitle }, 'WSL 状态'),
        loadError
          ? React.createElement('div', { style: STYLES.msgErr }, '插件 API 不可达：' + loadError)
          : React.createElement(
              React.Fragment,
              null,
              React.createElement(StatusLine, {
                label: '发行版',
                value: distroNames.map((d) => d.name + (d.default ? ' ★' : '')).join('、') || '未检测到',
              }),
              React.createElement(StatusLine, { label: 'WSL 变体', value: variants.length ? variants.join('、') : '未发布' }),
              React.createElement(StatusLine, {
                label: '活动通道',
                value: String((status && status.channels && status.channels.length) || 0),
              }),
            ),
        React.createElement('div', { style: STYLES.sectionTitle }, '添加 WSL 工作区'),
        React.createElement(
          'div',
          { style: STYLES.row },
          React.createElement(
            'select',
            { style: STYLES.input, value: distro, onChange: (e) => setDistro(e.target.value) },
            distroNames.map((d) =>
              React.createElement('option', { key: d.name, value: d.name }, d.name + (d.default ? '（默认）' : '')),
            ),
          ),
        ),
        React.createElement(
          'div',
          { style: STYLES.row },
          React.createElement('input', {
            style: STYLES.input,
            placeholder: '/home/you/project',
            value: path,
            onChange: (e) => setPath(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !busy) create()
            },
            spellCheck: false,
          }),
          React.createElement('button', { style: STYLES.button, disabled: busy || !distro, onClick: create }, busy ? '注册中…' : '注册'),
        ),
        React.createElement(
          'div',
          { style: Object.assign({}, STYLES.subtle, { marginTop: '6px' }) },
          '目录需已存在于发行版内；/mnt 不能作为工作区根。注册后在工作区选择器里就能看到它。',
        ),
        msg
          ? React.createElement('div', { style: msg.ok ? STYLES.msgOk : STYLES.msgErr }, msg.text)
          : null,
      )
    }

    // -- plugin ---------------------------------------------------------------

    function apply(ctx) {
      if (!ctx.slots) {
        console.error('dsh-wsl-overlay: this DSH has no slots service; the WSL panel stays unmounted')
        return
      }
      try {
        // Both seats register from the innermost callback: the rail entry and
        // the panel it opens appear together or not at all.
        ctx.slots.inject('main', () =>
          ctx.slots.inject('sidebar.panellist', () => {
            const stopMain = ctx.slots.register(
              { name: 'main', key: PANEL_ID, inject: () => ({}) },
              WslPanel,
            )
            const stopIcon = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 52, label: () => 'WSL 工作区' },
              WslIcon,
            )
            return () => {
              if (typeof stopIcon === 'function') stopIcon()
              if (typeof stopMain === 'function') stopMain()
            }
          }),
        )
      } catch (error) {
        console.error('dsh-wsl-overlay: registering the WSL panel failed', error)
      }
    }

    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
