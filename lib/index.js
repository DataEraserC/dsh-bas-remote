// dsh-bas-remote — SAP Business Application Studio (BAS) remote dev spaces for
// DeepSeek Harness.
//
// Host half. This plugin turns a BAS landscape into usable remote SSH
// endpoints:
//
//   • sign in to a landscape (browser hand-off, the token is stored in the
//     harness credential store — never in configuration),
//   • list the landscape's dev spaces and their state,
//   • connect a dev space: fetch its SSH private key, open the dev-channel
//     tunnel (`wss://port33765-<host>:443` → the dev space's sshd on
//     127.0.0.1:2222) and publish it as a loopback SSH endpoint plus a
//     `~/.ssh/config` entry,
//   • hand that endpoint to the harness remote-workspace tools (rw_connect),
//     plain `ssh`, or any IDE.
//
// Everything the SAP `app-studio-toolkit` "Remote Access for SAP Business
// Application Studio" extension does is reproduced here without VS Code:
// `@sap/bas-sdk`'s four REST calls are re-implemented in lib/landscape.js and
// the dev channel in lib/tunnel.js.
//
// Plugin Config MUST be a schemastery schema.

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEFAULT_LOGIN_PORT,
  LoginListener,
  extLoginUrl,
  getDevSpaceKey,
  isJwtUsable,
  jwtRemainingMs,
  landscapeCredentialId,
  landscapeHost,
  landscapeLabel,
  listDevSpaces,
  normalizeLandscape,
} from './landscape.js'
import { DevChannelTunnel } from './tunnel.js'
import {
  keyFilePath,
  removeKeyFile,
  removeSshConfigEntry,
  resolveSshPaths,
  sshHostAlias,
  upsertSshConfigEntry,
  writeKeyFile,
} from './sshconfig.js'

export const name = 'dsh-bas-remote'

export const inject = ['tools', 'credentials', 'systemPrompt', 'commands']

export const Config = z.object({
  /** Interface the landscape login page posts its token back to. */
  loginHost: z.string().default('127.0.0.1'),
  /** Port for that hand-off. The BAS login page always posts to 55532; change
   * this only together with a port forward that keeps 55532 reachable. */
  loginPort: z.number().step(1).min(1).max(65535).default(DEFAULT_LOGIN_PORT),
  /** Default ceiling for one awaited sign-in. */
  loginTimeoutMs: z.number().step(1).min(1000).default(180000),
  /** SSH config file to publish dev-space endpoints into. */
  sshConfigPath: z.string().default(''),
  /** Directory holding the fetched dev-space private keys. */
  sshDir: z.string().default(''),
  /** SSH user presented to a dev space (BAS always uses `user`). */
  sshUser: z.string().default('user'),
  /** Publish a `~/.ssh/config` entry per connected dev space. */
  manageSshConfig: z.boolean().default(true),
  /** Delete a dev space's key file on disconnect. */
  removeKeyOnDisconnect: z.boolean().default(false),
  /** Loopback port for the tunnel (0 asks the kernel for a free one). */
  localPort: z.number().step(1).min(0).max(65535).default(0),
  /** Inject an active-dev-space note into the system prompt. */
  promptSection: z.boolean().default(true),
  /** Landscape used when a tool call omits one, and pre-registered on load. */
  defaultLandscape: z.string().default(''),
  /** Verbose host-side diagnostics. */
  debug: z.boolean().default(false),
})

const OWNER = 'bas-remote'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function stateFile() {
  return join(dshHome(), OWNER, 'state.json')
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'))
    return {
      landscapes: Array.isArray(parsed?.landscapes) ? parsed.landscapes : [],
      lastDevSpace: typeof parsed?.lastDevSpace === 'string' ? parsed.lastDevSpace : '',
    }
  } catch {
    return { landscapes: [], lastDevSpace: '' }
  }
}

function writeState(state) {
  const file = stateFile()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function textTool() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

/**
 * Register the same JSON routes on both carriers: the Web host's HTTP server
 * and, when present, the harness `connection` fetch channel used by Desktop.
 * @param {object} ctx - cordis context.
 * @param {Array} routes - `{path, handler(req, res)}` entries, all POST-or-GET.
 */
function registerTransports(ctx, routes) {
  ctx.inject(['webServer'], (inner) => {
    const disposers = routes.map((route) =>
      inner.get('webServer').register({ kind: 'exact', path: route.path, handler: route.handler }),
    )
    inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-bas-remote.web-routes')
  })

  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    if (!connection || typeof connection.fetch?.register !== 'function') return
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(
          connection.fetch.register({
            path: `/api${route.path}`,
            methods: ['GET', 'POST'],
            requestBody: 'buffered',
            async fetch(request) {
              const url = new URL(request.url)
              let body = ''
              if (request.body) body = await request.text()
              const req = Object.assign(
                (function* () {
                  if (body) yield Buffer.from(body)
                })(),
                { method: request.method, url: `${route.path}${url.search}`, headers: request.headers },
              )
              const headers = new Headers()
              let status = 200
              let payload = ''
              const res = {
                setHeader(key, value) {
                  headers.set(key, value)
                },
                end(value) {
                  payload = value === undefined ? '' : String(value)
                },
                get statusCode() {
                  return status
                },
                set statusCode(value) {
                  status = value
                },
              }
              await route.handler(req, res)
              return new Response(payload, { status, headers })
            },
          }),
        )
      } catch (error) {
        console.warn(`[dsh-bas-remote] route ${route.path} was not registered: ${error.message}`)
      }
    }
    inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-bas-remote.fetch-routes')
  })
}

/**
 * Host plugin entry point.
 * @param {object} ctx - cordis context.
 * @param {object} config - resolved plugin config.
 */
export function apply(ctx, config) {
  const paths = resolveSshPaths({ sshConfigPath: config.sshConfigPath, sshDir: config.sshDir })
  const log = (level, message) => {
    if (config.debug || level === 'warn') console.warn(`[dsh-bas-remote] ${message}`)
  }

  let state = readState()
  /** @type {Map<string, object>} active tunnels keyed by `<landscape>/<devSpace id>`. */
  const tunnels = new Map()
  /** @type {object|null} the most recent sign-in attempt. */
  let pendingLogin = null

  if (config.defaultLandscape) {
    try {
      registerLandscape(config.defaultLandscape)
    } catch (error) {
      log('warn', `ignoring invalid defaultLandscape: ${error.message}`)
    }
  }

  function persist() {
    writeState(state)
  }

  function registerLandscape(input) {
    const landscape = normalizeLandscape(input)
    if (!state.landscapes.some((entry) => entry.url === landscape)) {
      state.landscapes.push({
        url: landscape,
        label: landscapeLabel(landscape),
        addedAt: Date.now(),
      })
      persist()
    }
    return landscape
  }

  function findLandscape(input) {
    const wanted = normalizeLandscape(input)
    return state.landscapes.find((entry) => entry.url === wanted) ?? null
  }

  function forgetLandscape(input) {
    const landscape = normalizeLandscape(input)
    state.landscapes = state.landscapes.filter((entry) => entry.url !== landscape)
    persist()
    return landscape
  }

  function resolveLandscape(input) {
    const raw = String(input ?? '').trim()
    if (raw) return findLandscape(raw)?.url ?? registerLandscape(raw)
    if (state.landscapes.length === 1) return state.landscapes[0].url
    throw new Error(
      state.landscapes.length === 0
        ? 'no BAS landscape is configured yet; call bas_login with the landscape URL first'
        : `several landscapes are configured (${state.landscapes.map((entry) => entry.url).join(', ')}); name one`,
    )
  }

  function credentialFor(landscape) {
    // The store admits only `^[a-z][a-z0-9-]*$` in either half of the key, so
    // the landscape host goes through the slugging helper rather than in raw.
    return credentialKey(OWNER, landscapeCredentialId(landscape))
  }

  async function readCredential(landscape) {
    try {
      const record = await ctx.credentials.readRecord(credentialFor(landscape))
      if (!record || record.kind !== 'grant') return null
      const payload = record.payload ?? {}
      if (!payload.jwt) return null
      return {
        jwt: String(payload.jwt),
        iasjwt: payload.iasjwt ? String(payload.iasjwt) : '',
        obtainedAt: Number(payload.obtainedAt ?? 0),
      }
    } catch (error) {
      log('warn', `cannot read stored credential: ${error.message}`)
      return null
    }
  }

  async function storeCredential(landscape, payload) {
    await ctx.credentials.modifyRecord(credentialFor(landscape), async () => ({
      kind: 'grant',
      payload: {
        landscape,
        jwt: payload.jwt,
        iasjwt: payload.iasjwt ?? '',
        obtainedAt: Date.now(),
      },
    }))
  }

  async function dropCredential(landscape) {
    try {
      await ctx.credentials.deleteRecord(credentialFor(landscape))
    } catch (error) {
      log('warn', `cannot delete stored credential: ${error.message}`)
    }
  }

  async function requireCredential(landscape) {
    const credential = await readCredential(landscape)
    if (!credential) {
      throw new Error(
        `${landscapeHost(landscape)} is not signed in; run /bas login ${landscape} (or the bas_login tool) first`,
      )
    }
    if (!isJwtUsable(credential.jwt)) {
      throw new Error(
        `the stored token for ${landscapeHost(landscape)} expired; sign in again with /bas login ${landscape}`,
      )
    }
    return credential
  }

  function closeLogin() {
    if (pendingLogin?.listener) {
      try {
        pendingLogin.listener.close()
      } catch {
        // Already closed.
      }
    }
  }

  async function startLogin(input) {
    const landscape = registerLandscape(input)
    if (pendingLogin && pendingLogin.landscape === landscape && !pendingLogin.settled) return pendingLogin
    closeLogin()
    const listener = new LoginListener({ host: config.loginHost, port: config.loginPort })
    await listener.start()
    const url = extLoginUrl(landscape, false)
    const entry = {
      landscape,
      url,
      listener,
      startedAt: Date.now(),
      settled: false,
      error: '',
      finishedAt: 0,
    }
    entry.promise = listener
      .wait(0)
      .then(async (payload) => {
        await storeCredential(landscape, payload)
        entry.settled = true
        entry.finishedAt = Date.now()
        log('info', `signed in to ${landscapeHost(landscape)}`)
      })
      .catch((error) => {
        entry.settled = true
        entry.error = error.message
        entry.finishedAt = Date.now()
      })
    pendingLogin = entry
    log('info', `waiting for the ${landscapeHost(landscape)} sign-in hand-off on ${config.loginHost}:${listener.boundPort}`)
    return entry
  }

  async function awaitLogin(entry, timeoutMs) {
    if (entry.settled) return entry
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : config.loginTimeoutMs
    await Promise.race([entry.promise, new Promise((resolve) => setTimeout(resolve, limit).unref?.())])
    return entry
  }

  function tunnelKey(landscape, wsId) {
    return `${landscape}/${wsId}`
  }

  function findTunnel(input) {
    const raw = String(input ?? '').trim()
    const entries = [...tunnels.entries()]
    if (!raw) {
      if (entries.length === 0) throw new Error('no dev space is connected')
      if (entries.length === 1) return entries[0]
      throw new Error(`several dev spaces are connected (${entries.map(([key]) => key).join(', ')}); name one`)
    }
    const exact = entries.find(([key]) => key === raw)
    if (exact) return exact
    const matches = entries.filter(([key, entry]) => {
      const id = key.slice(key.indexOf('/') + 1)
      return id === raw || entry.label === raw || id.startsWith(raw)
    })
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) throw new Error(`"${raw}" is not a connected dev space`)
    throw new Error(`"${raw}" matches several dev spaces: ${matches.map(([key]) => key).join(', ')}`)
  }

  async function devSpacesOf(landscape) {
    const credential = await requireCredential(landscape)
    return listDevSpaces(landscape, credential.jwt)
  }

  function pickDevSpace(spaces, wanted) {
    const raw = String(wanted ?? '').trim()
    if (!raw) throw new Error('a dev space name or id is required')
    const exact = spaces.filter((space) => space.id === raw)
    if (exact.length === 1) return exact[0]
    const byLabel = spaces.filter(
      (space) => space.label.toLowerCase() === raw.toLowerCase() || space.id.startsWith(raw),
    )
    if (byLabel.length === 1) return byLabel[0]
    if (byLabel.length === 0) {
      throw new Error(
        `no dev space matches "${raw}"; available: ${spaces.map((space) => `${space.label || '(unnamed)'} [${space.id}]`).join(', ') || '(none)'}`,
      )
    }
    throw new Error(`"${raw}" matches several dev spaces: ${byLabel.map((space) => space.id).join(', ')}`)
  }

  async function connectDevSpace({ landscape: landscapeInput, devSpace, localPort }) {
    const landscape = resolveLandscape(landscapeInput)
    const credential = await requireCredential(landscape)
    const spaces = await listDevSpaces(landscape, credential.jwt)
    const space = pickDevSpace(spaces, devSpace)
    if (!space.sshEnabled) {
      throw new Error(
        `dev space "${space.label || space.id}" does not expose SSH; add the "Remote Access" extension to the dev space in BAS and restart it`,
      )
    }

    const existing = tunnels.get(tunnelKey(landscape, space.id))
    if (existing) {
      if (existing.tunnel.active) return existing
      await existing.tunnel.stop().catch(() => {})
      tunnels.delete(tunnelKey(landscape, space.id))
    }

    const { key, wsUrl } = await getDevSpaceKey(landscape, credential.jwt, space.id)
    const keyFile = writeKeyFile(keyFilePath(paths.dir, wsUrl), key)
    const tunnel = new DevChannelTunnel({
      landscape,
      jwt: credential.jwt,
      wsUrl,
      localPort: Number.isFinite(localPort) ? localPort : config.localPort,
      username: config.sshUser,
      log,
    })

    let endpoint
    try {
      endpoint = await tunnel.start()
    } catch (error) {
      await tunnel.stop().catch(() => {})
      throw new Error(`cannot open the dev channel to ${space.label || space.id}: ${error.message}`)
    }

    const section = sshHostAlias(landscapeHost(landscape), space.id)
    let sshConfigWritten = false
    if (config.manageSshConfig) {
      try {
        upsertSshConfigEntry({
          configPath: paths.configPath,
          section,
          identityFile: keyFile,
          port: endpoint.localPort,
          user: config.sshUser,
        })
        sshConfigWritten = true
      } catch (error) {
        log('warn', `cannot update ${paths.configPath}: ${error.message}`)
      }
    }

    const entry = {
      key: tunnelKey(landscape, space.id),
      landscape,
      wsId: space.id,
      label: space.label,
      wsUrl,
      keyFile,
      section,
      sshConfigWritten,
      tunnel,
    }
    tunnels.set(entry.key, entry)
    state.lastDevSpace = space.id
    persist()

    // A dropped dev channel must not leave a stale `~/.ssh/config` entry.
    void tunnel.waitForClose().then(() => {
      const live = tunnels.get(entry.key)
      if (live !== entry) return
      tunnels.delete(entry.key)
      if (config.manageSshConfig) {
        try {
          removeSshConfigEntry({ configPath: paths.configPath, section })
        } catch (error) {
          log('warn', `cannot clean ${paths.configPath}: ${error.message}`)
        }
      }
      log('info', `dev channel for ${space.label || space.id} closed`)
    })

    return entry
  }

  async function disconnectDevSpace(input) {
    const [key, entry] = findTunnel(input)
    tunnels.delete(key)
    await entry.tunnel.stop().catch(() => {})
    if (config.manageSshConfig) {
      try {
        removeSshConfigEntry({ configPath: paths.configPath, section: entry.section })
      } catch (error) {
        log('warn', `cannot clean ${paths.configPath}: ${error.message}`)
      }
    }
    if (config.removeKeyOnDisconnect) removeKeyFile(entry.keyFile)
    return entry
  }

  async function statusReport() {
    const lines = []
    lines.push(`BAS landscapes: ${state.landscapes.length}`)
    for (const entry of state.landscapes) {
      const credential = await readCredential(entry.url)
      const remaining = credential ? jwtRemainingMs(credential.jwt) : null
      const auth = !credential
        ? 'not signed in'
        : isJwtUsable(credential.jwt)
          ? `signed in${remaining === null ? '' : `, token valid for ${formatDuration(remaining)}`}`
          : 'token expired'
      lines.push(`  - ${entry.url} (${auth})`)
    }
    if (state.landscapes.length === 0) {
      lines.push('  (none — add one with /bas login <landscape-url>)')
    }

    if (pendingLogin) {
      const state_ = pendingLogin.settled
        ? pendingLogin.error
          ? `failed: ${pendingLogin.error}`
          : 'completed'
        : `waiting for the browser hand-off on ${config.loginHost}:${pendingLogin.listener?.boundPort ?? ''}`
      lines.push(`Sign-in in progress: ${pendingLogin.landscape} — ${state_}`)
      if (!pendingLogin.settled) lines.push(`  Open: ${pendingLogin.url}`)
    }

    lines.push(`Connected dev spaces: ${tunnels.size}`)
    for (const entry of tunnels.values()) {
      const description = entry.tunnel.describe()
      const alive = description.active ? 'active' : `down${description.closedReason ? ` (${description.closedReason})` : ''}`
      lines.push(
        `  - ${entry.label || entry.wsId} [${entry.wsId}] on ${entry.landscape} — ${alive}`,
        `    ssh: ssh ${config.sshUser}@127.0.0.1 -p ${description.localPort} -i ${entry.keyFile}`,
        `    alias: ${entry.section}${entry.sshConfigWritten ? '' : ' (not published to ~/.ssh/config)'}`,
        `    harness: rw_connect host=127.0.0.1 port=${description.localPort} username=${config.sshUser} privateKeyPath=${entry.keyFile}`,
      )
    }
    if (tunnels.size === 0) {
      lines.push('  (none — /bas connect <dev space> after /bas login)')
    }
    lines.push(`SSH config: ${paths.configPath}${existsSync(paths.configPath) ? '' : ' (missing)'}`)
    return lines.join('\n')
  }

  // ── model tools ───────────────────────────────────────────────────────────

  const output = textTool()
  const tools = [
    defineTool({
      name: 'bas_status',
      description:
        'Show the SAP Business Application Studio (BAS) state of this harness: configured landscapes and whether their tokens are still valid, a pending browser sign-in, every connected dev space with its loopback SSH endpoint, and the managed ~/.ssh/config file. Call this first to orient, or after bas_login to see whether the hand-off completed.',
      parameters: {},
      output,
      async execute() {
        return { text: await statusReport() }
      },
    }),

    defineTool({
      name: 'bas_login',
      description:
        'Sign in to a BAS landscape. Registers the landscape URL if new and starts the browser hand-off: the landscape login page posts the token back to this host on 127.0.0.1:55532. Returns the URL to open. Call it again with the same landscape and a waitMs to block until the hand-off lands (or use bas_status to poll). The token is kept in the harness credential store, not in configuration.',
      parameters: {
        landscape: {
          type: 'string',
          required: true,
          description: 'Landscape URL or host, e.g. https://my-tenant.eu10.applicationstudio.cloud.sap',
        },
        waitMs: {
          type: 'integer',
          description: 'Block up to this many milliseconds for the browser hand-off (0 returns immediately with the URL)',
        },
      },
      output,
      async execute(args) {
        const entry = await startLogin(args.landscape)
        const waitMs = Number(args.waitMs ?? 0)
        if (waitMs > 0) await awaitLogin(entry, waitMs)
        const lines = [
          `Landscape: ${entry.landscape}`,
          `Open this URL in a browser and sign in: ${entry.url}`,
          'The landscape posts the token back to this host, so the browser must reach ' +
            `${config.loginHost}:${entry.listener?.boundPort ?? config.loginPort}` +
            (config.loginHost === '127.0.0.1' ? ' (forward that port when the harness runs on another machine).' : '.'),
        ]
        if (entry.settled) {
          lines.push(entry.error ? `Sign-in failed: ${entry.error}` : 'Sign-in completed; the token is stored.')
        } else {
          lines.push(
            `Waiting for the hand-off (call bas_login with waitMs, or bas_status, to check).`,
          )
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'bas_logout',
      description: 'Forget the stored BAS landscape token for one landscape (the landscape stays configured).',
      parameters: { landscape: { type: 'string', required: true, description: 'Landscape URL or host' } },
      output,
      async execute(args) {
        const landscape = resolveLandscape(args.landscape)
        await dropCredential(landscape)
        return { text: `Removed the stored token for ${landscapeHost(landscape)}.` }
      },
    }),

    defineTool({
      name: 'bas_forget',
      description: 'Disconnect every dev space of a landscape, forget its token and remove the landscape.',
      parameters: { landscape: { type: 'string', required: true, description: 'Landscape URL or host' } },
      output,
      async execute(args) {
        const landscape = resolveLandscape(args.landscape)
        for (const [key, entry] of [...tunnels.entries()]) {
          if (entry.landscape !== landscape) continue
          await disconnectDevSpace(key).catch(() => {})
        }
        await dropCredential(landscape)
        forgetLandscape(landscape)
        return { text: `Removed ${landscape} and its stored token.` }
      },
    }),

    defineTool({
      name: 'bas_devspaces',
      description:
        'List the dev spaces of a BAS landscape: display name, id, running status, extension pack, and whether the dev space exposes SSH (the "Remote Access" extension). Requires a completed bas_login.',
      parameters: {
        landscape: { type: 'string', description: 'Landscape URL or host (optional when exactly one is configured)' },
      },
      output,
      async execute(args) {
        const landscape = resolveLandscape(args.landscape)
        const spaces = await devSpacesOf(landscape)
        if (spaces.length === 0) return { text: `${landscape} has no dev spaces.` }
        const lines = [`Dev spaces on ${landscape}:`]
        for (const space of spaces) {
          lines.push(
            `- ${space.label || '(unnamed)'} [${space.id}]`,
            `  status: ${space.status}${space.sshEnabled ? ', ssh: enabled' : ', ssh: NOT enabled (add the Remote Access extension and restart)'}`,
            `  pack: ${space.packDisplayName || space.pack || '(unknown)'}${space.url ? `, url: ${space.url}` : ''}`,
          )
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'bas_connect',
      description:
        'Connect a BAS dev space and expose it as a local SSH endpoint: fetches the dev-space private key, opens the dev-channel tunnel and publishes a ~/.ssh/config entry. The result names the loopback host/port, the key file and the `rw_connect` call that adopts the dev space as a remote workspace.',
      parameters: {
        devSpace: { type: 'string', required: true, description: 'Dev space display name or id (see bas_devspaces)' },
        landscape: { type: 'string', description: 'Landscape URL or host (optional when exactly one is configured)' },
        localPort: { type: 'integer', description: 'Loopback port to listen on (0 or omitted picks a free port)' },
      },
      output,
      async execute(args) {
        const entry = await connectDevSpace({
          landscape: args.landscape,
          devSpace: args.devSpace,
          localPort: Number(args.localPort ?? 0) || 0,
        })
        const description = entry.tunnel.describe()
        return {
          text: [
            `Connected dev space "${entry.label || entry.wsId}" [${entry.wsId}] on ${entry.landscape}.`,
            `SSH endpoint: 127.0.0.1:${description.localPort} (user ${config.sshUser})`,
            `Private key: ${entry.keyFile}`,
            entry.sshConfigWritten ? `SSH alias: ${entry.section}` : 'SSH alias: not published to ~/.ssh/config',
            'To work inside it, adopt it as this session\'s remote workspace:',
            `rw_connect host=127.0.0.1 port=${description.localPort} username=${config.sshUser} privateKeyPath=${entry.keyFile}`,
            'then rw_pick_workspace to choose a directory (BAS projects usually live under /home/user/projects).',
            'Use bas_disconnect when the dev space is no longer needed.',
          ].join('\n'),
        }
      },
    }),

    defineTool({
      name: 'bas_disconnect',
      description:
        'Close the dev-channel tunnel of a connected dev space, remove its ~/.ssh/config entry and stop forwarding. Without an argument the only connected dev space is closed; with several connected, name one.',
      parameters: {
        devSpace: { type: 'string', description: 'Dev space display name or id (optional when exactly one is connected)' },
      },
      output,
      async execute(args) {
        const entry = await disconnectDevSpace(args.devSpace)
        return { text: `Disconnected dev space "${entry.label || entry.wsId}" [${entry.wsId}].` }
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)

  // ── human command ─────────────────────────────────────────────────────────

  ctx.commands.register({
    name: 'bas',
    description: 'SAP Business Application Studio remote dev spaces (status | login | logout | devspaces | connect | disconnect)',
    input: { hint: 'status | login <landscape> | devspaces [landscape] | connect <dev space> | disconnect [dev space] | logout <landscape>' },
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? '').trim()
      const [subcommand = 'status', ...rest] = raw.split(/\s+/).filter(Boolean)
      const argument = rest.join(' ').trim()
      try {
        switch (subcommand) {
          case 'status':
            return { kind: 'success', text: await statusReport() }
          case 'login': {
            const entry = await startLogin(argument)
            const done = await awaitLogin(entry, config.loginTimeoutMs)
            if (!done.settled) {
              return {
                kind: 'success',
                text: [
                  `Sign in to ${done.landscape} at: ${done.url}`,
                  `Still waiting for the browser hand-off on ${config.loginHost}:${done.listener?.boundPort ?? config.loginPort}.`,
                  'Run /bas status when you are done.',
                ].join('\n'),
              }
            }
            if (done.error) return { kind: 'error', text: `Sign-in failed: ${done.error}` }
            return { kind: 'success', text: `Signed in to ${done.landscape}; the token is stored.` }
          }
          case 'devspaces': {
            const landscape = resolveLandscape(argument)
            const spaces = await devSpacesOf(landscape)
            if (spaces.length === 0) return { kind: 'success', text: `${landscape} has no dev spaces.` }
            return {
              kind: 'success',
              text: spaces
                .map(
                  (space) =>
                    `${space.sshEnabled ? '[ssh]' : '[   ]'} ${space.status.padEnd(8)} ${space.label || '(unnamed)'} [${space.id}]`,
                )
                .join('\n'),
            }
          }
          case 'connect': {
            const entry = await connectDevSpace({ devSpace: argument, localPort: config.localPort })
            const description = entry.tunnel.describe()
            return {
              kind: 'success',
              text: [
                `Connected ${entry.label || entry.wsId} [${entry.wsId}].`,
                `ssh ${config.sshUser}@127.0.0.1 -p ${description.localPort} -i ${entry.keyFile}`,
                entry.sshConfigWritten ? `alias ${entry.section}` : 'not published to ~/.ssh/config',
              ].join('\n'),
            }
          }
          case 'disconnect': {
            const entry = await disconnectDevSpace(argument)
            return { kind: 'success', text: `Disconnected ${entry.label || entry.wsId} [${entry.wsId}].` }
          }
          case 'logout': {
            const landscape = resolveLandscape(argument)
            await dropCredential(landscape)
            return { kind: 'success', text: `Removed the stored token for ${landscapeHost(landscape)}.` }
          }
          case 'forget': {
            const landscape = resolveLandscape(argument)
            for (const [key, entry] of [...tunnels.entries()]) {
              if (entry.landscape !== landscape) continue
              await disconnectDevSpace(key).catch(() => {})
            }
            await dropCredential(landscape)
            forgetLandscape(landscape)
            return { kind: 'success', text: `Removed ${landscape}.` }
          }
          default:
            return {
              kind: 'error',
              text: `unknown subcommand "${subcommand}"; use status, login, logout, forget, devspaces, connect or disconnect`,
            }
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  })

  // ── system prompt: active dev spaces ──────────────────────────────────────

  if (config.promptSection) {
    ctx.systemPrompt.section({
      name: 'dsh-bas-remote',
      order: 89,
      text: () => {
        const entries = [...tunnels.values()].filter((entry) => entry.tunnel.active)
        if (entries.length === 0) return ''
        const lines = [
          'SAP Business Application Studio dev spaces are connected over local SSH tunnels:',
        ]
        for (const entry of entries) {
          const description = entry.tunnel.describe()
          lines.push(
            `- ${entry.label || entry.wsId} [${entry.wsId}]: ssh 127.0.0.1 port ${description.localPort}, user ${config.sshUser}, key ${entry.keyFile}` +
              ` (alias ${entry.section}); adopt it with rw_connect host=127.0.0.1 port=${description.localPort} username=${config.sshUser} privateKeyPath=${entry.keyFile}.`,
          )
        }
        lines.push('These tunnels are managed by dsh-bas-remote (tools: bas_status, bas_connect, bas_disconnect).')
        return lines.join('\n')
      },
    })
  }

  // ── Web/Desktop JSON routes ───────────────────────────────────────────────

  function snapshot() {
    return {
      landscapes: state.landscapes.map((entry) => entry),
      pendingLogin: pendingLogin
        ? {
            landscape: pendingLogin.landscape,
            url: pendingLogin.url,
            settled: pendingLogin.settled,
            error: pendingLogin.error,
            startedAt: pendingLogin.startedAt,
          }
        : null,
      tunnels: [...tunnels.values()].map((entry) => ({
        key: entry.key,
        landscape: entry.landscape,
        wsId: entry.wsId,
        label: entry.label,
        keyFile: entry.keyFile,
        section: entry.section,
        sshConfigWritten: entry.sshConfigWritten,
        ...entry.tunnel.describe(),
      })),
      sshConfigPath: paths.configPath,
      sshUser: config.sshUser,
      loginHost: config.loginHost,
      loginPort: config.loginPort,
    }
  }

  async function authStates() {
    const result = {}
    for (const entry of state.landscapes) {
      const credential = await readCredential(entry.url)
      result[entry.url] = credential
        ? { signedIn: isJwtUsable(credential.jwt), remainingMs: jwtRemainingMs(credential.jwt) }
        : { signedIn: false, remainingMs: null }
    }
    return result
  }

  const routes = [
    {
      path: '/bas-remote/state',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          sendJson(res, 200, { ok: true, state: snapshot(), auth: await authStates() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/bas-remote/landscape',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const action = String(body.action ?? 'add')
          if (action === 'add') {
            const landscape = registerLandscape(body.landscape)
            return sendJson(res, 200, { ok: true, landscape })
          }
          if (action === 'forget') {
            const landscape = resolveLandscape(body.landscape)
            for (const [key, entry] of [...tunnels.entries()]) {
              if (entry.landscape !== landscape) continue
              await disconnectDevSpace(key).catch(() => {})
            }
            await dropCredential(landscape)
            forgetLandscape(landscape)
            return sendJson(res, 200, { ok: true })
          }
          return sendJson(res, 400, { ok: false, error: `unknown action "${action}"` })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/bas-remote/login',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const entry = await startLogin(body.landscape)
          const waitMs = Number(body.waitMs ?? 0)
          if (waitMs > 0) await awaitLogin(entry, waitMs)
          sendJson(res, 200, {
            ok: true,
            url: entry.url,
            landscape: entry.landscape,
            settled: entry.settled,
            error: entry.error,
            loginHost: config.loginHost,
            loginPort: entry.listener?.boundPort ?? config.loginPort,
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/bas-remote/logout',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const landscape = resolveLandscape(body.landscape)
          await dropCredential(landscape)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/bas-remote/devspaces',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const landscape = resolveLandscape(body.landscape)
          const spaces = await devSpacesOf(landscape)
          sendJson(res, 200, { ok: true, devSpaces: spaces })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/bas-remote/connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const entry = await connectDevSpace({
            landscape: body.landscape,
            devSpace: body.devSpace,
            localPort: Number(body.localPort ?? 0) || 0,
          })
          const description = entry.tunnel.describe()
          sendJson(res, 200, {
            ok: true,
            tunnel: {
              key: entry.key,
              label: entry.label,
              wsId: entry.wsId,
              section: entry.section,
              keyFile: entry.keyFile,
              sshConfigWritten: entry.sshConfigWritten,
              ...description,
            },
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/bas-remote/disconnect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const entry = await disconnectDevSpace(body.devSpace)
          sendJson(res, 200, { ok: true, key: entry.key })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message })
        }
      },
    },
  ]

  registerTransports(ctx, routes)

  ctx.effect(
    () => () => {
      closeLogin()
      for (const entry of tunnels.values()) {
        void entry.tunnel.stop().catch(() => {})
        if (config.manageSshConfig) {
          try {
            removeSshConfigEntry({ configPath: paths.configPath, section: entry.section })
          } catch {
            // Best effort during shutdown.
          }
        }
      }
      tunnels.clear()
    },
    'dsh-bas-remote.teardown',
  )
}
