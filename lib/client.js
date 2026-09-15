// dsh-bas-remote — client half (browser).
//
// A settings section page showing the BAS remote-dev-space state: configured
// landscapes with sign-in status, dev-space lists, and one-click connect /
// disconnect buttons.  The panel polls `/bas-remote/state` every few seconds
// so it stays in sync without a push channel.
//
// Written as a classic script following the dsh-remote pattern
// (window.__ModuleLoader__.load / require('react') / inline styles with
// --dsw-alias-* tokens).  No bundler required.

window.__ModuleLoader__.load({
  id: 'dsh-bas-remote',
  factory: (require) => {
    var React = require('react')
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var NS = 'dsh-bas-remote'

    // ── i18n ──────────────────────────────────────────────────────────────

    var L = {
      zh: {
        'nav':                  'BAS 远程开发空间',
        'intro':                '管理 SAP Business Application Studio 的远程开发空间：登录 landscapes，列出 dev spaces，一键连接 SSH 隧道。',
        'landscapes':           'Landscapes',
        'noLandscapes':         '还没有添加 Landscape。在下方输入 URL 登录。',
        'addLandscape':         '添加 Landscape',
        'addPlaceholder':       'https://my-tenant.eu10.applicationstudio.cloud.sap',
        'signIn':               '登录',
        'signInWaiting':        '等待浏览器登录…',
        'signInComplete':       '已登录',
        'signInExpired':        'Token 已过期，请重新登录',
        'signInError':          '登录失败',
        'signOut':              '退出登录',
        'openUrl':              '在浏览器中打开此 URL 完成登录：',
        'devSpaces':            '开发空间',
        'noDevSpaces':          '暂无开发空间',
        'status':               '状态',
        'connect':              '连接',
        'connecting':           '正在连接…',
        'disconnect':           '断开',
        'connected':            '已连接',
        'sshEnabled':           'SSH 已启用',
        'sshDisabled':          'SSH 未启用',
        'sshHint':              '请在 BAS 中添加 Remote Access 扩展并重启开发空间',
        'sshEndpoint':          'SSH 端点',
        'sshKey':               '私钥',
        'sshAlias':             'SSH 别名',
        'rwCommand':            'RW 命令',
        'refresh':              '刷新',
        'remove':               '移除',
        'removeConfirm':        '确定移除此 Landscape 及其 Token？',
        'loginPortHint':        '浏览器必须能访问此地址：',
        'tunnels':              '活跃隧道',
        'noTunnels':            '暂无活跃隧道',
        'pollError':            '无法连接到 dsh-bas-remote 后端',
      },
      en: {
        'nav':                  'BAS Remote Dev Spaces',
        'intro':                'Manage SAP Business Application Studio remote dev spaces: sign in to landscapes, list dev spaces, and connect SSH tunnels.',
        'landscapes':           'Landscapes',
        'noLandscapes':         'No landscapes added yet. Enter a URL below to sign in.',
        'addLandscape':         'Add Landscape',
        'addPlaceholder':       'https://my-tenant.eu10.applicationstudio.cloud.sap',
        'signIn':               'Sign In',
        'signInWaiting':        'Waiting for browser sign-in…',
        'signInComplete':       'Signed in',
        'signInExpired':        'Token expired — sign in again',
        'signInError':          'Sign-in failed',
        'signOut':              'Sign Out',
        'openUrl':              'Open this URL in a browser to sign in:',
        'devSpaces':            'Dev Spaces',
        'noDevSpaces':          'No dev spaces found.',
        'status':               'Status',
        'connect':              'Connect',
        'connecting':           'Connecting…',
        'disconnect':           'Disconnect',
        'connected':            'Connected',
        'sshEnabled':           'SSH enabled',
        'sshDisabled':          'SSH not enabled',
        'sshHint':              'Add the Remote Access extension in BAS and restart the dev space',
        'sshEndpoint':          'SSH endpoint',
        'sshKey':               'Key file',
        'sshAlias':             'SSH alias',
        'rwCommand':            'RW command',
        'refresh':              'Refresh',
        'remove':               'Remove',
        'removeConfirm':        'Remove this landscape and its token?',
        'loginPortHint':        'The browser must reach this address:',
        'tunnels':              'Active Tunnels',
        'noTunnels':            'No active tunnels.',
        'pollError':            'Cannot reach dsh-bas-remote backend',
      },
    }

    var tr = function (key) { return L.en[key] ?? key }
    var ACTIVE_LANG = 'en'

    // ── theme tokens (same pattern as dsh-remote) ──────────────────────────

    var v = function (name, fb) { return 'var(' + name + ', ' + fb + ')' }
    var T = {
      bg:         v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
      bg2:        v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.10)'),
      bg3:        v('--dsw-alias-bg-layer-3', 'rgba(128,128,128,0.04)'),
      border:     v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
      borderL3:   v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
      text:       v('--dsw-alias-label-primary', '#e0e0e0'),
      textMuted:  v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
      danger:     v('--dsw-static-red-500', '#e06c75'),
      ok:         v('--dsw-static-green-500', '#4caf7d'),
      warn:       v('--dsw-static-yellow-500', '#e6c07b'),
      radius:     8,
      radiusLg:   12,
      gap:        12,
    }

    // ── API helper ─────────────────────────────────────────────────────────

    function apiPath(path) {
      return window.location && window.location.protocol === 'dsh-app:'
        ? '/api' + path : path
    }

    async function api(method, path, body) {
      var opts = { method: method, headers: {} }
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json'
        opts.body = JSON.stringify(body)
      }
      var res = await fetch(apiPath(path), opts)
      var data = await res.json().catch(function () { return {} })
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
      return data
    }

    // ── small components ───────────────────────────────────────────────────

    function Pill(props) {
      var color = props.ok === true ? T.ok : props.ok === false ? T.danger : T.warn
      return React.createElement('span', {
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          backgroundColor: color, marginRight: 6, verticalAlign: 'middle',
        },
      })
    }

    function Spinner() {
      return React.createElement('span', {
        style: { display: 'inline-block', width: 14, height: 14, border: '2px solid ' + T.border, borderTopColor: T.textMuted, borderRadius: '50%', animation: 'dsh-bas-spin 0.6s linear infinite', marginRight: 6, verticalAlign: 'middle' },
      })
    }

    function Button(props) {
      var primary = props.variant === 'primary'
      var danger = props.variant === 'danger'
      var bg = primary ? 'rgba(59,130,246,0.18)' : danger ? 'rgba(224,108,117,0.15)' : T.bg2
      var color = primary ? '#60a5fa' : danger ? T.danger : T.text
      var border = primary ? '1px solid rgba(59,130,246,0.4)' : danger ? '1px solid rgba(224,108,117,0.4)' : '1px solid ' + T.border
      return React.createElement('button', {
        onClick: props.onClick,
        disabled: props.disabled,
        style: {
          padding: '5px 12px', borderRadius: T.radius, background: bg, color: color,
          border: border, cursor: props.disabled ? 'not-allowed' : 'pointer',
          fontSize: 13, lineHeight: '18px', fontWeight: 500, opacity: props.disabled ? 0.5 : 1,
          transition: 'background 0.15s, opacity 0.15s',
        },
      }, props.children)
    }

    function Input(props) {
      return React.createElement('input', {
        value: props.value,
        onChange: props.onChange,
        placeholder: props.placeholder,
        onKeyDown: props.onKeyDown,
        style: {
          flex: 1, padding: '6px 10px', borderRadius: T.radius,
          border: '1px solid ' + T.border, background: T.bg3, color: T.text,
          fontSize: 13, outline: 'none', minWidth: 0,
        },
      })
    }

    // ── Landscape card ─────────────────────────────────────────────────────

    function LandscapeCard(props) {
      var landscape = props.landscape
      var auth = props.auth
      var devSpaces = props.devSpaces
      var tunnels = props.tunnels
      var actions = props.actions

      var signedIn = auth && auth.signedIn
      var loginPending = props.pendingLogin && props.pendingLogin.landscape === landscape.url && !props.pendingLogin.settled
      var loginError = props.pendingLogin && props.pendingLogin.landscape === landscape.url && props.pendingLogin.settled && props.pendingLogin.error

      var sections = []

      // Header row
      sections.push(React.createElement('div', {
        key: 'header', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
      },
        React.createElement(Pill, { ok: signedIn ? true : false }),
        React.createElement('span', { style: { fontWeight: 600, fontSize: 14, color: T.text, flex: 1, wordBreak: 'break-all' } }, landscape.url),
        !signedIn && !loginPending
          ? React.createElement(Button, { variant: 'primary', onClick: function () { actions.login(landscape.url) } }, tr('signIn'))
          : null,
        loginPending
          ? React.createElement('span', { style: { color: T.warn, fontSize: 12 } }, React.createElement(Spinner, null), tr('signInWaiting'))
          : null,
        signedIn
          ? React.createElement(Button, { onClick: function () { actions.logout(landscape.url) } }, tr('signOut'))
          : null,
      ))

      // Login URL / error
      if (loginPending && props.pendingLogin && props.pendingLogin.url) {
        sections.push(React.createElement('div', {
          key: 'login-url', style: { padding: '8px 12px', background: T.bg3, borderRadius: T.radius, fontSize: 12, color: T.textMuted, marginBottom: 8, wordBreak: 'break-all' },
        },
          React.createElement('div', { style: { marginBottom: 4 } }, tr('openUrl')),
          React.createElement('a', { href: props.pendingLogin.url, target: '_blank', rel: 'noopener', style: { color: '#60a5fa', textDecoration: 'underline' } }, props.pendingLogin.url),
          React.createElement('div', { style: { marginTop: 4, fontSize: 11 } }, tr('loginPortHint') + ' ' + (props.loginHost || '127.0.0.1') + ':' + String(props.loginPort || 55532)),
        ))
      }
      if (loginError) {
        sections.push(React.createElement('div', {
          key: 'login-error', style: { padding: '6px 10px', background: 'rgba(224,108,117,0.1)', borderRadius: T.radius, fontSize: 12, color: T.danger, marginBottom: 8 },
        }, tr('signInError') + ': ' + loginError))
      }
      if (signedIn) {
        var remaining = auth.remainingMs
        var remainingText = remaining === null ? '' : (remaining > 3600000 ? Math.round(remaining / 3600000) + 'h' : remaining > 60000 ? Math.round(remaining / 60000) + 'm' : Math.round(remaining / 1000) + 's')
        sections.push(React.createElement('div', {
          key: 'auth-ok', style: { fontSize: 12, color: T.ok, marginBottom: 4 },
        }, tr('signInComplete') + (remainingText ? ' (' + remainingText + ')' : '')))
      }

      // Dev spaces
      if (signedIn && devSpaces) {
        sections.push(React.createElement('div', { key: 'ds-title', style: { fontWeight: 600, fontSize: 13, color: T.text, marginTop: 8, marginBottom: 4 } }, tr('devSpaces')))
        if (!devSpaces || devSpaces.length === 0) {
          sections.push(React.createElement('div', { key: 'ds-empty', style: { fontSize: 12, color: T.textMuted } }, tr('noDevSpaces')))
        } else {
          for (var i = 0; i < devSpaces.length; i++) {
            var ds = devSpaces[i]
            var tunnel = tunnels && tunnels.find(function (t) { return t.wsId === ds.id })
            sections.push(React.createElement(DevSpaceRow, {
              key: ds.id, devSpace: ds, tunnel: tunnel, actions: actions,
            }))
          }
        }
        sections.push(React.createElement('div', { key: 'ds-refresh', style: { marginTop: 6 } },
          React.createElement(Button, { onClick: function () { actions.refreshDevSpaces(landscape.url) } }, tr('refresh')),
        ))
      }

      return React.createElement('div', {
        style: {
          border: '1px solid ' + T.border, borderRadius: T.radiusLg, padding: 16,
          background: T.bg, marginBottom: 12,
        },
      }, sections)
    }

    // ── Dev-space row ──────────────────────────────────────────────────────

    function DevSpaceRow(props) {
      var ds = props.devSpace
      var tunnel = props.tunnel
      var actions = props.actions

      var statusColor = ds.status === 'RUNNING' ? T.ok : ds.status === 'STARTING' ? T.warn : T.danger
      var sshBadge = ds.sshEnabled ? tr('sshEnabled') : tr('sshDisabled')
      var sshColor = ds.sshEnabled ? T.ok : T.warn

      var row = React.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
          borderBottom: '1px solid ' + T.border,
        },
      },
        React.createElement(Pill, { ok: ds.status === 'RUNNING' ? true : false }),
        React.createElement('span', { style: { fontWeight: 500, fontSize: 13, color: T.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ds.label || ds.id),
        React.createElement('span', { style: { fontSize: 11, color: statusColor, flexShrink: 0 } }, ds.status),
        React.createElement('span', { style: { fontSize: 11, color: sshColor, flexShrink: 0 } }, sshBadge),
      )

      // Tunnel info / connect button
      var actions2
      if (tunnel) {
        actions2 = React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 0 24px', fontSize: 12 },
        },
          React.createElement(Pill, { ok: tunnel.active ? true : false }),
          React.createElement('span', { style: { color: T.textMuted } }, tr('sshEndpoint') + ': 127.0.0.1:' + tunnel.localPort),
          React.createElement(Button, { variant: 'danger', onClick: function () { actions.disconnect(ds.id) } }, tr('disconnect')),
        )
      } else {
        actions2 = React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 0 24px', fontSize: 12 },
        },
          ds.sshEnabled
            ? React.createElement(Button, { variant: 'primary', onClick: function () { actions.connect(ds.id) } }, tr('connect'))
            : React.createElement('span', { style: { color: T.textMuted, fontSize: 11 } }, tr('sshHint')),
        )
      }

      return React.createElement('div', { key: ds.id }, row, actions2)
    }

    // ── Active Tunnels summary ─────────────────────────────────────────────

    function TunnelsSection(props) {
      var tunnels = props.tunnels
      if (!tunnels || tunnels.length === 0) {
        return React.createElement('div', {
          style: { padding: '12px 0', fontSize: 12, color: T.textMuted },
        }, tr('noTunnels'))
      }
      return React.createElement('div', null,
        tunnels.map(function (t) {
          return React.createElement('div', {
            key: t.key, style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
              borderBottom: '1px solid ' + T.border, fontSize: 12,
            },
          },
            React.createElement(Pill, { ok: t.active }),
            React.createElement('span', { style: { fontWeight: 500, color: T.text, flex: 1 } }, t.label || t.wsId),
            React.createElement('span', { style: { color: T.textMuted } }, '127.0.0.1:' + t.localPort),
            React.createElement(Button, { variant: 'danger', onClick: function () { props.actions.disconnect(t.wsId) } }, tr('disconnect')),
          )
        }),
      )
    }

    // ── Main settings page ─────────────────────────────────────────────────

    function BasRemotePage() {
      var _s = React.useState(null)
      var state = _s[0], setState = _s[1]
      var _e = React.useState(null)
      var pollError = _e[0], setPollError = _e[1]
      var _add = React.useState('')
      var addUrl = _add[0], setAddUrl = _add[1]
      var _ds = React.useState({})
      var devSpacesCache = _ds[0], setDevSpacesCache = _ds[1]
      var _c = React.useState({})
      var connecting = _c[0], setConnecting = _c[1]

      var poll = React.useCallback(async function () {
        try {
          var res = await api('GET', '/bas-remote/state')
          // The route answers { ok, state, auth }: auth is a sibling of state,
          // and every consumer below reads state.auth, so merge it in here.
          setState(Object.assign({}, res.state || {}, { auth: res.auth || {} }))
          setPollError(null)
        } catch (err) {
          setPollError(err.message || 'unknown error')
        }
      }, [])

      React.useEffect(function () {
        poll()
        var timer = setInterval(poll, 4000)
        return function () { clearInterval(timer) }
      }, [poll])

      // Auto-fetch dev spaces when landscapes become signed in
      React.useEffect(function () {
        if (!state || !state.landscapes) return
        var auth = (state && state.auth) || {}
        state.landscapes.forEach(function (ls) {
          if (auth[ls.url] && auth[ls.url].signedIn && !devSpacesCache[ls.url]) {
            api('POST', '/bas-remote/devspaces', { landscape: ls.url })
              .then(function (res) {
                setDevSpacesCache(function (prev) { return Object.assign({}, prev, { [ls.url]: res.devSpaces || [] }) })
              })
              .catch(function () {})
          }
        })
      }, [state])

      var actions = React.useMemo(function () {
        return {
          login: async function (url) {
            await api('POST', '/bas-remote/login', { landscape: url, waitMs: 0 })
            poll()
          },
          logout: async function (url) {
            await api('POST', '/bas-remote/logout', { landscape: url })
            setDevSpacesCache(function (prev) {
              var next = Object.assign({}, prev); delete next[url]; return next
            })
            poll()
          },
          addLandscape: async function () {
            var url = addUrl.trim()
            if (!url) return
            await api('POST', '/bas-remote/landscape', { action: 'add', landscape: url })
            setAddUrl('')
            poll()
          },
          removeLandscape: async function (url) {
            await api('POST', '/bas-remote/landscape', { action: 'forget', landscape: url })
            setDevSpacesCache(function (prev) {
              var next = Object.assign({}, prev); delete next[url]; return next
            })
            poll()
          },
          refreshDevSpaces: async function (url) {
            try {
              var res = await api('POST', '/bas-remote/devspaces', { landscape: url })
              setDevSpacesCache(function (prev) { return Object.assign({}, prev, { [url]: res.devSpaces || [] }) })
            } catch (err) {
              setPollError(err.message)
            }
          },
          connect: async function (wsId) {
            setConnecting(function (prev) { return Object.assign({}, prev, { [wsId]: true }) })
            try {
              await api('POST', '/bas-remote/connect', { devSpace: wsId })
              poll()
            } catch (err) {
              setPollError(err.message)
            } finally {
              setConnecting(function (prev) { var n = Object.assign({}, prev); delete n[wsId]; return n })
            }
          },
          disconnect: async function (wsId) {
            try {
              await api('POST', '/bas-remote/disconnect', { devSpace: wsId })
              poll()
            } catch (err) {
              setPollError(err.message)
            }
          },
        }
      }, [addUrl, poll])

      var sections = []

      // Title + intro
      sections.push(React.createElement('div', { key: 'title', style: { fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 4 } }, tr('nav')))
      sections.push(React.createElement('div', { key: 'intro', style: { fontSize: 12, color: T.textMuted, marginBottom: 16 } }, tr('intro')))

      // Error bar
      if (pollError) {
        sections.push(React.createElement('div', {
          key: 'error', style: { padding: '6px 10px', borderRadius: T.radius, background: 'rgba(224,108,117,0.1)', color: T.danger, fontSize: 12, marginBottom: 12 },
        }, tr('pollError') + ': ' + pollError))
      }

      // Landscapes
      sections.push(React.createElement('div', { key: 'ls-title', style: { fontWeight: 600, fontSize: 13, color: T.text, marginBottom: 8 } }, tr('landscapes')))
      var landscapes = (state && state.landscapes) || []
      var auth = (state && state.auth) || {}
      var tunnels = (state && state.tunnels) || []

      if (landscapes.length === 0) {
        sections.push(React.createElement('div', { key: 'ls-empty', style: { fontSize: 12, color: T.textMuted, marginBottom: 12 } }, tr('noLandscapes')))
      }
      for (var li = 0; li < landscapes.length; li++) {
        var ls = landscapes[li]
        sections.push(React.createElement(LandscapeCard, {
          key: ls.url, landscape: ls, auth: auth[ls.url],
          devSpaces: devSpacesCache[ls.url] || null,
          tunnels: tunnels, actions: actions,
          pendingLogin: state.pendingLogin,
          loginHost: state.loginHost, loginPort: state.loginPort,
        }))
      }

      // Add landscape
      sections.push(React.createElement('div', {
        key: 'add', style: { display: 'flex', gap: 8, marginBottom: 16 },
      },
        React.createElement(Input, {
          value: addUrl, placeholder: tr('addPlaceholder'),
          onChange: function (e) { setAddUrl(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter') actions.addLandscape() },
        }),
        React.createElement(Button, { variant: 'primary', onClick: actions.addLandscape }, tr('addLandscape')),
      ))

      // Active tunnels
      sections.push(React.createElement('div', { key: 'tunnels-title', style: { fontWeight: 600, fontSize: 13, color: T.text, marginBottom: 8 } }, tr('tunnels')))
      sections.push(React.createElement(TunnelsSection, { key: 'tunnels', tunnels: tunnels, actions: actions }))

      return React.createElement('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 860 } }, sections)
    }

    // ── locale wiring ──────────────────────────────────────────────────────

    function wireLocale(ctx) {
      var locale = ctx && ctx.get && ctx.get('locale')
      if (!locale || typeof locale.register !== 'function') return
      var dispose = locale.register(NS, { zh: L.zh, en: L.en })
      var bound = locale.bind(NS)
      ACTIVE_LANG = locale.activeLanguage || 'en'
      tr = function (key, params) {
        var raw = bound(key, params)
        return raw !== undefined ? raw : (L.en[key] ?? key)
      }
      return dispose
    }

    // ── shell overlay status pill ──────────────────────────────────────────

    function BasStatusPill() {
      var _s = React.useState(null)
      var state = _s[0], setState = _s[1]

      React.useEffect(function () {
        var active = true
        async function poll() {
          try {
            var res = await api('GET', '/bas-remote/state')
            if (active) setState(res.state || null)
          } catch { /* backend offline */ }
        }
        poll()
        var timer = setInterval(poll, 5000)
        return function () { active = false; clearInterval(timer) }
      }, [])

      var tunnels = (state && state.tunnels) || []
      var count = tunnels.length
      var allActive = count > 0 && tunnels.every(function (t) { return t.active })

      if (count === 0) return null

      var dotColor = allActive ? T.ok : tunnels.some(function (t) { return t.active }) ? T.warn : T.danger

      return React.createElement('div', {
        onClick: function () {
          try { window.dispatchEvent(new CustomEvent('dsh-navigate', { detail: { path: '/settings' } })) } catch {}
        },
        title: count + ' dev space' + (count > 1 ? 's' : '') + ' connected',
        style: {
          display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px',
          borderRadius: T.radius, background: T.bg2, border: '1px solid ' + T.border,
          cursor: 'pointer', fontSize: 12, lineHeight: '16px', color: T.text,
          userSelect: 'none', transition: 'background 0.15s',
        },
      },
        React.createElement('span', {
          style: { width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 },
        }),
        React.createElement('span', { style: { fontWeight: 500 } }, 'BAS'),
        React.createElement('span', { style: { color: T.textMuted } }, count),
      )
    }

    // ── apply (client entry point) ─────────────────────────────────────────

    function apply(ctx) {
      var disposeLocale = wireLocale(ctx)

      var slots = ctx.get('slots')

      // Settings section page
      slots.inject('settings.section', function () {
        return slots.register(
          {
            name: 'settings.section',
            id: 'dsh-bas-remote',
            order: 42,
            label: function () { return tr('nav') },
            locale: NS,
          },
          function () { return React.createElement(BasRemotePage, null) },
        )
      })

      // Shell overlay status pill
      slots.inject('shell.overlay', function () {
        return slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-bas-remote',
            order: 25,
            locale: NS,
          },
          function () { return React.createElement(BasStatusPill, null) },
        )
      })

      if (disposeLocale) {
        ctx.effect(function () { return disposeLocale }, NS + '.locale')
      }
    }

    exports.name = NS
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
