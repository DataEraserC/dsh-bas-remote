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
import { createServer } from 'node:net'

import {
  DEFAULT_LOGIN_PORT,
  DEV_SPACE_RUNNING,
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
  startDevSpace as requestDevSpaceStart,
  stopDevSpace as requestDevSpaceStop,
  probeDevSpaceSsh,
  waitForDevSpaceStatus,
} from './landscape.js'
import { DevChannelTunnel } from './tunnel.js'
import {
  DEFAULT_BRIDGE_DIR,
  DEFAULT_BRIDGE_PORT,
  bridgeState,
  connectSsh,
  ensureBridge,
  stopBridge,
} from './bridge.js'
import {
  keyFilePath,
  publishSshEndpoint,
  removeKeyFile,
  resolveSshPaths,
  sshConfigBlock,
  sshHostAlias,
  unpublishSshEndpoint,
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
  /** Ceiling for waiting on a dev-space start/stop to reach a final status. */
  devSpaceTimeoutMs: z.number().step(1).min(1000).default(240000),
  /** SSH config file to publish dev-space endpoints into (`config` mode). */
  sshConfigPath: z.string().default(''),
  /** Directory holding the fetched dev-space private keys. */
  sshDir: z.string().default(''),
  /** SSH user presented to a dev space (BAS always uses `user`). */
  sshUser: z.string().default('user'),
  /**
   * Where dev-space SSH endpoints are published:
   * `off` (default) writes nothing and reports the block to paste instead,
   * `fragment` maintains `<sshDir>/dsh-bas-remote.conf` for an `Include`,
   * `config` adds a marked block to `sshConfigPath`/`~/.ssh/config`.
   * A nix/home-manager managed config is left untouched in every mode.
   */
  sshConfigMode: z.string().default('off'),
  /** Fragment file used in `fragment` mode (default `<sshDir>/dsh-bas-remote.conf`). */
  sshConfigFragmentPath: z.string().default(''),
  /** Deprecated alias for `sshConfigMode: 'config'`; leave false. */
  manageSshConfig: z.boolean().default(false),
  /** Delete a dev space's key file on disconnect. */
  removeKeyOnDisconnect: z.boolean().default(false),
  /** Loopback port for the tunnel (0 asks the kernel for a free one). */
  localPort: z.number().step(1).min(0).max(65535).default(0),
  /**
   * Per-dev-space fixed port assignments.
   * Key: dev space id, Value: { dropbear: number, bridge: number }.
   * When set, these ports are used instead of random ones.
   * If a port is occupied and strict mode is on, the connect fails.
   * Example: { "ws-4gdt1": { "dropbear": 44000, "bridge": 44001 } }
   */
  forwardPorts: z.dict(z.object({
    dropbear: z.number().step(1).min(1).max(65535),
    bridge: z.number().step(1).min(1).max(65535),
  })).default({}),
  /**
   * When true, connecting a dev space with a port that is already in use
   * fails instead of falling back to a random port.
   */
  forwardPortsStrict: z.boolean().default(true),
  /** How often a failed dev-channel handshake is retried before giving up. */
  connectAttempts: z.number().step(1).min(1).max(5).default(3),
  /**
   * Serve SFTP in connected dev spaces.
   *
   * A BAS dev space runs dropbear without `sftp-server`, so SFTP over the dev
   * channel fails with exit code 127 and every SFTP-based remote tool breaks.
   * When enabled, a small SSH server carrying exec + SFTP is uploaded into the
   * dev space and forwarded over the same dev channel; `rw_connect` then points
   * at that endpoint and mirror/sync work. Requires node and npm inside the dev
   * space (BAS images have both).
   */
  sftpBridge: z.boolean().default(true),
  /** Port that bridge listens on inside the dev space. */
  sftpBridgePort: z.number().step(1).min(1).max(65535).default(DEFAULT_BRIDGE_PORT),
  /** Bridge directory in the dev space (`~` when relative). */
  sftpBridgeDir: z.string().default(DEFAULT_BRIDGE_DIR),
  /** Allow the one-time `npm install ssh2` inside the dev space. */
  sftpBridgeInstall: z.boolean().default(true),
  /** Ceiling for the first-time bridge setup (upload + npm install). */
  sftpBridgeTimeoutMs: z.number().step(1).min(10000).default(300000),
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
      forwardPorts: parsed?.forwardPorts || {},
    }
  } catch {
    return { landscapes: [], lastDevSpace: '', forwardPorts: {} }
  }
}

function writeState(state) {
  const file = stateFile()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/**
 * Check if a port is available on localhost.
 * @param {number} port - port to check.
 * @returns {Promise<boolean>} true if the port is free.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => { server.close(() => resolve(true)) })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Resolve the port for a dev space, checking availability.
 * @param {string} wsId - dev space id.
 * @param {'dropbear'|'bridge'} kind - port kind.
 * @param {object} config - plugin config.
 * @param {object} state - plugin state.
 * @returns {Promise<number>} resolved port (0 for random).
 * @throws if strict mode and port is occupied.
 */
async function resolveForwardPort(wsId, kind, config, state) {
  const configPorts = config.forwardPorts?.[wsId]?.[kind]
  const statePorts = state.forwardPorts?.[wsId]?.[kind]
  const port = configPorts || statePorts || 0
  if (port === 0) return 0
  const free = await isPortFree(port)
  if (free) return port
  if (config.forwardPortsStrict) {
    throw new Error(`port ${port} for ${kind} of ${wsId} is already in use (forwardPortsStrict is on)`)
  }
  log('warn', `port ${port} for ${kind} of ${wsId} is occupied, falling back to random`)
  return 0
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
    // Tunnel keys are `<landscape>/<dev-space id>` and a landscape URL contains
    // slashes, so match the stored id/label instead of slicing the key.
    const matches = entries.filter(([, entry]) => entry.wsId === raw || entry.label === raw || entry.wsId.startsWith(raw))
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) throw new Error(`"${raw}" is not a connected dev space`)
    throw new Error(`"${raw}" matches several dev spaces: ${matches.map(([key]) => key).join(', ')}`)
  }

  /** @type {Map<string, {value: boolean, at: number}>} cached `/key` probe results. */
  const sshProbeCache = new Map()
  const SSH_PROBE_TTL_MS = 60000

  /**
   * Fill in `sshEnabled` for every RUNNING dev space by probing its key
   * endpoint. Stopped spaces stay `null` (unknown): their runtime is gone, so
   * there is nothing to probe until they start.
   * @param {string} landscape - normalized landscape origin.
   * @param {string} jwt - landscape JSON Web Token.
   * @param {object[]} spaces - flattened dev spaces.
   * @returns {Promise<object[]>} the same dev spaces with `sshEnabled` resolved.
   */
  async function withSshAvailability(landscape, jwt, spaces) {
    await Promise.all(
      spaces.map(async (space) => {
        if (space.status !== DEV_SPACE_RUNNING) {
          space.sshEnabled = null
          return
        }
        const cacheKey = `${landscape}/${space.id}`
        const cached = sshProbeCache.get(cacheKey)
        if (cached && Date.now() - cached.at < SSH_PROBE_TTL_MS) {
          space.sshEnabled = cached.value
          return
        }
        const value = await probeDevSpaceSsh(space, jwt)
        sshProbeCache.set(cacheKey, { value, at: Date.now() })
        space.sshEnabled = value
      }),
    )
    return spaces
  }

  async function devSpacesOf(landscape) {
    const credential = await requireCredential(landscape)
    const spaces = await listDevSpaces(landscape, credential.jwt)
    return withSshAvailability(landscape, credential.jwt, spaces)
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

  /**
   * BAS runs at most two dev spaces per landscape at a time; the SAP extension
   * refuses to start a third one (`isItPossibleToStart` in the toolkit).
   */
  const MAX_ACTIVE_DEV_SPACES = 2

  function assertDevSpaceSlotFree(landscape, spaces, target) {
    const active = spaces.filter(
      (space) =>
        space.id !== target.id && (space.status === DEV_SPACE_RUNNING || space.status === 'STARTING'),
    )
    if (active.length >= MAX_ACTIVE_DEV_SPACES) {
      throw new Error(
        `${landscapeHost(landscape)} already has ${active.length} running or starting dev spaces ` +
          `(${active.map((space) => space.label || space.id).join(', ')}); BAS allows ${MAX_ACTIVE_DEV_SPACES} at a time — stop one with bas_stop first`,
      )
    }
  }

  function devSpaceWaitMs(waitMs) {
    return Number.isFinite(waitMs) && waitMs > 0 ? waitMs : config.devSpaceTimeoutMs
  }

  /**
   * Wait for one dev space to reach a final status and insist on the wanted one.
   * @returns {Promise<object>} the dev space in its final observed state.
   */
  async function waitForFinalStatus(landscape, jwt, space, wanted, waitMs) {
    const timeout = devSpaceWaitMs(waitMs)
    const settled = await waitForDevSpaceStatus(
      landscape,
      jwt,
      space.id,
      (current) => current.status === wanted || current.status === 'ERROR',
      { timeoutMs: timeout, intervalMs: 3000 },
    )
    if (settled.status !== wanted) {
      throw new Error(
        `dev space "${space.label || space.id}" is ${settled.status} after ${Math.round(timeout / 1000)}s (wanted ${wanted}); check it in BAS`,
      )
    }
    return settled
  }

  /**
   * Make sure a dev space is RUNNING, starting it the way the SAP extension
   * does on connect. Returns the refreshed dev space plus whether it had to be
   * started.
   */
  async function ensureDevSpaceRunning(landscape, credential, space, waitMs) {
    if (space.status === DEV_SPACE_RUNNING) return { space, started: false }
    let spaces = await listDevSpaces(landscape, credential.jwt)
    let current = spaces.find((entry) => entry.id === space.id) ?? space
    if (current.status === DEV_SPACE_RUNNING) return { space: current, started: false }
    if (current.status === 'STOPPING') {
      // A space on its way down finishes first; a start issued now would be lost.
      current = await waitForFinalStatus(landscape, credential.jwt, current, 'STOPPED', waitMs)
      spaces = await listDevSpaces(landscape, credential.jwt)
    }
    const wasStopped = current.status === 'STOPPED'
    if (wasStopped) {
      assertDevSpaceSlotFree(landscape, spaces, current)
      await requestDevSpaceStart(landscape, credential.jwt, current.id, current.label || current.id)
      log('info', `starting dev space ${current.label || current.id} [${current.id}]`)
      forgetSshProbe(landscape, current.id)
    }
    const settled = await waitForFinalStatus(landscape, credential.jwt, current, DEV_SPACE_RUNNING, waitMs)
    return { space: settled, started: wasStopped }
  }

  /**
   * Start a dev space and (by default) wait until it reports RUNNING.
   * @returns {Promise<{landscape: string, space: object, started: boolean, alreadyRunning: boolean}>}
   */
  async function startDevSpaceFlow({ landscape: landscapeInput, devSpace, wait = true, waitMs }) {
    const landscape = resolveLandscape(landscapeInput)
    const credential = await requireCredential(landscape)
    const spaces = await listDevSpaces(landscape, credential.jwt)
    const space = pickDevSpace(spaces, devSpace)
    if (space.status === DEV_SPACE_RUNNING) {
      return { landscape, space, started: false, alreadyRunning: true }
    }
    if (!wait) {
      if (space.status === 'STOPPED') {
        assertDevSpaceSlotFree(landscape, spaces, space)
        await requestDevSpaceStart(landscape, credential.jwt, space.id, space.label || space.id)
        log('info', `starting dev space ${space.label || space.id} [${space.id}]`)
        forgetSshProbe(landscape, space.id)
        return { landscape, space, started: true, alreadyRunning: false }
      }
      return { landscape, space, started: false, alreadyRunning: false }
    }
    const result = await ensureDevSpaceRunning(landscape, credential, space, waitMs)
    return { landscape, ...result, alreadyRunning: false }
  }

  /**
   * Stop a dev space and (by default) wait until it reports STOPPED. Any tunnel
   * into it is closed first, because the dev channel dies with the runtime.
   */
  async function stopDevSpaceFlow({ landscape: landscapeInput, devSpace, wait = true, waitMs }) {
    const landscape = resolveLandscape(landscapeInput)
    const credential = await requireCredential(landscape)
    const spaces = await listDevSpaces(landscape, credential.jwt)
    const space = pickDevSpace(spaces, devSpace)
    if (space.status === 'STOPPED') {
      return { landscape, space, stopped: false, alreadyStopped: true }
    }
    const key = tunnelKey(landscape, space.id)
    if (tunnels.has(key)) await disconnectDevSpace(key).catch(() => {})
    // A dev space that is already stopping is not asked again; one that is still
    // starting does get the request, otherwise it would come up instead.
    if (space.status !== 'STOPPING') {
      await requestDevSpaceStop(landscape, credential.jwt, space.id, space.label || space.id)
      log('info', `stopping dev space ${space.label || space.id} [${space.id}]`)
      forgetSshProbe(landscape, space.id)
    }
    if (!wait) return { landscape, space, stopped: true, alreadyStopped: false }
    const settled = await waitForFinalStatus(landscape, credential.jwt, space, 'STOPPED', waitMs)
    return { landscape, space: settled, stopped: true, alreadyStopped: false }
  }

  /** @param {string} landscape - normalized landscape origin. @param {string} wsId - dev space id. */
  function forgetSshProbe(landscape, wsId) {
    sshProbeCache.delete(`${landscape}/${wsId}`)
  }

  /**
   * What actually works over a BAS dev-channel tunnel.
   *
   * The dev space's sshd is dropbear and the image ships no `sftp-server`
   * (`/usr/lib/sftp-server` does not exist), so the SFTP subsystem fails with
   * exit code 127 while exec channels work. Every SFTP-based remote tool
   * therefore reports "not a directory (or unreachable)" or a failed session.
   * @param {object} entry - tunnel entry.
   * @returns {string[]} guidance lines.
   */
  function remoteWorkspaceLines(entry) {
    const port = entry.tunnel.describe().localPort
    if (entry.bridge) {
      return [
        'SFTP cannot be served by this dev space\'s own sshd (dropbear ships no sftp-server), so this',
        'plugin runs a small SSH server inside the dev space and forwards it over the same dev channel.',
        `Full endpoint (exec + SFTP): 127.0.0.1:${entry.bridge.localPort}`,
        'To work inside it, adopt it as this session\'s remote workspace:',
        `rw_connect host=127.0.0.1 port=${entry.bridge.localPort} username=${config.sshUser} privateKeyPath=${entry.keyFile}`,
        'Commands then run with rw_exec; rw_stat/rw_read_file/rw_write_file/rw_sync/rw_push and',
        'dsh-remote\'s mirror/pick work over SFTP on that same endpoint.',
        `Plain SSH/exec endpoint of the dev space itself (no SFTP): 127.0.0.1:${port}`,
      ]
    }
    return [
      'To work inside it, adopt it as this session\'s remote workspace:',
      `rw_connect host=127.0.0.1 port=${port} username=${config.sshUser} privateKeyPath=${entry.keyFile}`,
      'Commands then run with rw_exec. BAS dev spaces run dropbear without an sftp-server, so the',
      'SFTP-based tools (rw_stat, rw_read_file, rw_write_file, rw_sync, rw_push, and dsh-remote\'s',
      'mirror/pick → "not a directory (or unreachable)") cannot work here. Either enable',
      '`sftpBridge` (default on) so this plugin provides SFTP, or move files over exec instead:',
      `  scp -O -P ${port} -i ${entry.keyFile} -r ./dir ${config.sshUser}@127.0.0.1:/home/user/projects/`,
      `  tar c -C ./dir . | ssh -p ${port} -i ${entry.keyFile} ${config.sshUser}@127.0.0.1 'tar x -C /home/user/projects/dir'`,
    ]
  }

  /** @param {object} space - flattened dev space. @returns {string} its SSH key state. */
  function sshStateLabel(space) {
    if (space.sshEnabled === true) return 'key available'
    if (space.sshEnabled === false) return 'no key from the runtime'
    return 'not probed (start it first)'
  }

  /** @returns {string} a one-line status label for a dev space. */
  function devSpaceName(space) {
    return `${space.label || space.id} [${space.id}]`
  }

  // ── SSH endpoint publishing ───────────────────────────────────────────────

  /**
   * Where dev-space endpoints go: `off` writes nothing, `fragment` maintains a
   * file this plugin owns, `config` edits `~/.ssh/config` (legacy). A
   * nix/home-manager managed config is usually not writable and would be
   * reverted on the next switch, so the default writes nothing at all.
   * @returns {'off'|'fragment'|'config'} the effective mode.
   */
  function sshConfigMode() {
    if (config.manageSshConfig === true) return 'config'
    const mode = String(config.sshConfigMode ?? 'off').toLowerCase()
    return mode === 'fragment' || mode === 'config' ? mode : 'off'
  }

  /** @returns {string} the fragment file this plugin owns in `fragment` mode. */
  function sshFragmentPath() {
    // Defaults next to the key directory, which follows sshDir/sshConfigPath.
    return config.sshConfigFragmentPath || join(paths.dir, 'dsh-bas-remote.conf')
  }

  /** Header written when the fragment file is created. */
  const SSH_FRAGMENT_HEADER = [
    '# dsh-bas-remote — dev-space SSH endpoints maintained by the harness plugin.',
    '# Reference it from your own SSH config, e.g. in home-manager:',
    '#   Include ~/.ssh/dsh-bas-remote.conf',
    '',
    '',
  ].join('\n')

  /**
   * Publish one dev-space endpoint according to the configured mode. Never
   * writes when the mode is `off`, and never writes a file that is a symlink or
   * not writable.
   * @param {object} options - entry options.
   * @param {string} options.section - `Host` alias.
   * @param {string} options.identityFile - private-key path.
   * @param {number} options.port - loopback port serving the dev space sshd.
   * @returns {{section: string, mode: string, written: boolean, target: string, reason: string, block: string}}
   */
  function publishSshEntry({ section, identityFile, port }) {
    const mode = sshConfigMode()
    if (mode === 'off') {
      const block = sshConfigBlock({ section, identityFile, port, user: config.sshUser })
      return { section, mode, written: false, target: '', reason: 'sshConfigMode is off', block }
    }
    const target = mode === 'fragment' ? sshFragmentPath() : paths.configPath
    const published = publishSshEndpoint({
      target,
      section,
      identityFile,
      port,
      user: config.sshUser,
      header: mode === 'fragment' ? SSH_FRAGMENT_HEADER : '',
    })
    if (!published.written) log('warn', `left ${target} untouched: ${published.reason}`)
    return { mode, ...published }
  }

  /**
   * Remove the endpoint of one dev space from whichever file holds it.
   * @param {object} entry - tunnel entry with its publish record.
   * @returns {boolean} whether a file changed.
   */
  function unpublishSshEntry(entry) {
    const mode = entry?.ssh?.mode ?? 'off'
    if (mode === 'off') return false
    const target = mode === 'fragment' ? sshFragmentPath() : paths.configPath
    try {
      return unpublishSshEndpoint({ target, section: entry.section })
    } catch (error) {
      log('warn', `cannot clean ${target}: ${error.message}`)
      return false
    }
  }

  /**
   * Human-facing lines describing where a dev-space endpoint ended up.
   * @param {object} publish - result of {@link publishSshEntry}.
   * @returns {string[]} lines for a tool result.
   */
  function sshPublishLines(publish) {
    if (publish.written && publish.mode === 'fragment') {
      return [
        `SSH alias: ${publish.section}`,
        `Written to ${publish.target}; add \`Include ${publish.target}\` to your SSH config to activate it.`,
      ]
    }
    if (publish.written) {
      return [`SSH alias: ${publish.section} (marked block in ${publish.target})`]
    }
    return [
      `SSH config left untouched (${publish.reason}).`,
      `Add this to your SSH config to get the alias ${publish.section}:`,
      ...publish.block.split('\n').map((line) => `  ${line}`),
    ]
  }

  /**
   * Bring up the SFTP bridge of a freshly connected dev space.
   *
   * Failures are reported and swallowed: without the bridge the endpoint still
   * serves exec, so a connect must not fail because SFTP could not be added.
   * @param {object} options - bridge options.
   * @param {object} options.tunnel - live dev-channel tunnel.
   * @param {string} options.keyFile - key file of the dev space.
   * @param {string} options.key - key contents.
   * @param {object} options.space - flattened dev space.
   * @returns {Promise<object|null>} the bridge record, or null.
   */
  async function startSftpBridge({ tunnel, key, space }) {
    const name = space.label || space.id
    try {
      const bridge = await ensureBridge({
        tunnelPort: tunnel.describe().localPort,
        privateKey: key,
        username: config.sshUser,
        remotePort: config.sftpBridgePort,
        dir: config.sftpBridgeDir || DEFAULT_BRIDGE_DIR,
        install: config.sftpBridgeInstall,
        timeoutMs: config.sftpBridgeTimeoutMs,
        log,
      })
      // Resolve the bridge port: per-dev-space config > random
      const bridgeLocalPort = await resolveForwardPort(space.id, 'bridge', config, state)
      const localPort = await tunnel.addForward(bridge.remotePort, bridgeLocalPort)
      // Prove the whole path — forward, handshake, SFTP — before advertising it.
      const session = await connectSsh({ port: localPort, privateKey: key, username: config.sshUser })
      try {
        const sftp = await session.sftp()
        await new Promise((resolve, reject) => sftp.stat('/', (error) => (error ? reject(error) : resolve())))
      } finally {
        session.end()
      }
      log('info', `SFTP bridge for ${name} ready on 127.0.0.1:${localPort}`)
      return { ...bridge, localPort }
    } catch (error) {
      log('warn', `SFTP bridge for ${name} unavailable: ${error.message}`)
      await tunnel.removeForward(config.sftpBridgePort).catch(() => {})
      return null
    }
  }

  async function connectDevSpace({ landscape: landscapeInput, devSpace, localPort }) {
    const landscape = resolveLandscape(landscapeInput)
    const credential = await requireCredential(landscape)
    const spaces = await listDevSpaces(landscape, credential.jwt)
    const picked = pickDevSpace(spaces, devSpace)
    // Mirrors the SAP extension, which starts a stopped dev space when you ask
    // to open it rather than failing on "no startup URL".
    const { space } = await ensureDevSpaceRunning(landscape, credential, picked, config.devSpaceTimeoutMs)

    const existing = tunnels.get(tunnelKey(landscape, space.id))
    if (existing) {
      if (existing.tunnel.active) return existing
      await existing.tunnel.stop().catch(() => {})
      tunnels.delete(tunnelKey(landscape, space.id))
    }

    let key
    let wsUrl
    try {
      ;({ key, wsUrl } = await getDevSpaceKey(landscape, credential.jwt, space.id))
    } catch (error) {
      // The dev space is running but served no usable key: this is the only
      // case in which the "Remote Access" extension can really be the cause.
      throw new Error(
        `cannot fetch the SSH key of ${space.label || space.id}: ${error.message}. ` +
          'Dev spaces normally serve a key from their runtime; if it stays missing, re-open the dev space in BAS.',
      )
    }
    sshProbeCache.set(`${landscape}/${space.id}`, { value: true, at: Date.now() })
    const keyFile = writeKeyFile(keyFilePath(paths.dir, wsUrl), key)
    
    // Resolve the dropbear port: per-dev-space config > global config > random
    const dropbearPort = Number.isFinite(localPort) ? localPort
      : await resolveForwardPort(space.id, 'dropbear', config, state)
    
    const tunnel = new DevChannelTunnel({
      landscape,
      jwt: credential.jwt,
      wsUrl,
      localPort: dropbearPort,
      username: config.sshUser,
      connectAttempts: config.connectAttempts,
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
    const ssh = publishSshEntry({ section, identityFile: keyFile, port: endpoint.localPort })
    const bridge = config.sftpBridge ? await startSftpBridge({ tunnel, key, space }) : null

    const entry = {
      key: tunnelKey(landscape, space.id),
      landscape,
      wsId: space.id,
      label: space.label,
      wsUrl,
      keyFile,
      section,
      ssh,
      bridge,
      sshConfigWritten: ssh.written,
      tunnel,
    }
    tunnels.set(entry.key, entry)
    state.lastDevSpace = space.id
    persist()

    // A dropped dev channel must not leave a stale config entry behind.
    void tunnel.waitForClose().then(() => {
      const live = tunnels.get(entry.key)
      if (live !== entry) return
      tunnels.delete(entry.key)
      unpublishSshEntry(entry)
      log('info', `dev channel for ${space.label || space.id} closed`)
    })

    return entry
  }

  async function disconnectDevSpace(input) {
    const [key, entry] = findTunnel(input)
    tunnels.delete(key)
    // The bridge lives inside the dev space and survives a dropped tunnel, so
    // stop it while the dropbear endpoint is still reachable.
    if (entry.bridge) {
      try {
        const stopped = await stopBridge({
          tunnelPort: entry.tunnel.describe().localPort,
          privateKey: readFileSync(entry.keyFile, 'utf8'),
          username: config.sshUser,
          dir: entry.bridge.dir,
        })
        if (stopped) log('debug', `stopped the SFTP bridge of ${entry.label || entry.wsId}`)
      } catch (error) {
        log('warn', `could not stop the SFTP bridge of ${entry.label || entry.wsId}: ${error.message}`)
      }
    }
    await entry.tunnel.stop().catch(() => {})
    unpublishSshEntry(entry)
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
        entry.bridge
          ? `    sftp: 127.0.0.1:${entry.bridge.localPort} (bridge pid ${entry.bridge.pid}, exec + SFTP)`
          : '    sftp: not bridged (dropbear ships no sftp-server)',
        `    alias: ${entry.section}${
          entry.ssh?.written ? ` (in ${entry.ssh.target})` : entry.ssh ? ` (not published: ${entry.ssh.reason})` : ''
        }`,
        `    harness: rw_connect host=127.0.0.1 port=${entry.bridge ? entry.bridge.localPort : description.localPort} username=${config.sshUser} privateKeyPath=${entry.keyFile}`,
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
        'Show the SAP Business Application Studio (BAS) state of this harness: configured landscapes and whether their tokens are still valid, a pending browser sign-in, every connected dev space with its loopback SSH endpoint, and where SSH endpoints are published. Call this first to orient, or after bas_login to see whether the hand-off completed.',
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
        'List the dev spaces of a BAS landscape: display name, id, running status (RUNNING | STARTING | STOPPED | STOPPING | ERROR), extension pack, and whether the dev space exposes SSH (the "Remote Access" extension). A STOPPED dev space is started with bas_start (or implicitly by bas_connect). Requires a completed bas_login.',
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
            `  status: ${space.status}, ssh: ${sshStateLabel(space)}`,
            `  pack: ${space.packDisplayName || space.pack || '(unknown)'}${space.url ? `, url: ${space.url}` : ''}`,
          )
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'bas_start',
      description:
        'Start (resume) a BAS dev space and wait until it reports RUNNING, mirroring the SAP extension\'s start action (`PUT <landscape>/ws-manager/api/v1/workspace/<id>` with `Suspended: false`). A landscape runs at most two dev spaces at a time; when both slots are taken the call fails and names the dev spaces holding them. Requires a completed bas_login.',
      parameters: {
        devSpace: { type: 'string', required: true, description: 'Dev space display name or id (see bas_devspaces)' },
        landscape: { type: 'string', description: 'Landscape URL or host (optional when exactly one is configured)' },
        waitMs: { type: 'integer', description: 'Give up waiting for RUNNING after this long (defaults to the devSpaceTimeoutMs config)' },
      },
      output,
      async execute(args) {
        const result = await startDevSpaceFlow({
          landscape: args.landscape,
          devSpace: args.devSpace,
          waitMs: Number(args.waitMs ?? 0) || 0,
        })
        const name = devSpaceName(result.space)
        const where = landscapeHost(result.landscape)
        if (result.alreadyRunning) return { text: `Dev space "${name}" is already RUNNING on ${where}.` }
        return {
          text: [
            `Dev space "${name}" is ${result.space.status} on ${where}.`,
            `Connect it with bas_connect devSpace=${result.space.id}.`,
          ].join('\n'),
        }
      },
    }),

    defineTool({
      name: 'bas_stop',
      description:
        'Stop (suspend) a BAS dev space and wait until it reports STOPPED, mirroring the SAP extension\'s stop action (`PUT <landscape>/ws-manager/api/v1/workspace/<id>` with `Suspended: true`). Any dev-channel tunnel into it is closed first, because the runtime disappears with the dev space. Requires a completed bas_login.',
      parameters: {
        devSpace: { type: 'string', required: true, description: 'Dev space display name or id (see bas_devspaces)' },
        landscape: { type: 'string', description: 'Landscape URL or host (optional when exactly one is configured)' },
        waitMs: { type: 'integer', description: 'Give up waiting for STOPPED after this long (defaults to the devSpaceTimeoutMs config)' },
      },
      output,
      async execute(args) {
        const result = await stopDevSpaceFlow({
          landscape: args.landscape,
          devSpace: args.devSpace,
          waitMs: Number(args.waitMs ?? 0) || 0,
        })
        const name = devSpaceName(result.space)
        const where = landscapeHost(result.landscape)
        if (result.alreadyStopped) return { text: `Dev space "${name}" is already STOPPED on ${where}.` }
        return { text: `Dev space "${name}" is ${result.space.status} on ${where}.` }
      },
    }),

    defineTool({
      name: 'bas_connect',
      description:
        'Connect a BAS dev space and expose it as a local SSH endpoint: fetches the dev-space private key, opens the dev-channel tunnel and reports the SSH `Host` block (only written to disk when sshConfigMode is set). A stopped dev space is started first (as the SAP extension does), then waited for. The result names the loopback host/port, the key file, the `rw_connect` call that adopts the dev space as a remote workspace, and which remote tools the dev space can actually serve: BAS sshd\'s serve exec but no SFTP, so when `sftpBridge` is on (default) a small SSH server carrying exec + SFTP is installed inside the dev space and the reported `rw_connect` endpoint serves both; if that fails the result says so and only exec works.',
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
            `SSH endpoint: 127.0.0.1:${description.localPort} (user ${config.sshUser})${
              entry.bridge ? ` — exec only; SFTP: 127.0.0.1:${entry.bridge.localPort}` : ''
            }`,
            `Private key: ${entry.keyFile}`,
            ...sshPublishLines(entry.ssh ?? { written: false, reason: 'nothing published', block: '', section: entry.section }),
            ...remoteWorkspaceLines(entry),
            'Use bas_disconnect when the dev space is no longer needed.',
          ].join('\n'),
        }
      },
    }),

    defineTool({
      name: 'bas_disconnect',
      description:
        'Close the dev-channel tunnel of a connected dev space, remove its published SSH endpoint and stop forwarding. Without an argument the only connected dev space is closed; with several connected, name one.',
      parameters: {
        devSpace: { type: 'string', description: 'Dev space display name or id (optional when exactly one is connected)' },
      },
      output,
      async execute(args) {
        const entry = await disconnectDevSpace(args.devSpace)
        return { text: `Disconnected dev space "${entry.label || entry.wsId}" [${entry.wsId}].` }
      },
    }),
    defineTool({
      name: 'bas_bridge',
      description:
        'Inspect or stop the SFTP bridge of a connected dev space. BAS dev spaces run dropbear without an sftp-server, so this plugin installs a small SSH server (exec + SFTP) inside the dev space and forwards it over the dev channel; this reports whether it is installed, running, listening and what its log says, or stops it (which turns the endpoint back into exec-only).',
      parameters: {
        devSpace: { type: 'string', description: 'Dev space display name or id (optional when exactly one is connected)' },
        action: { type: 'string', enum: ['status', 'stop'], description: 'status reports the bridge, stop removes it (default: status)' },
      },
      output,
      async execute(args) {
        const [, entry] = findTunnel(args.devSpace)
        const state_ = await bridgeState({
          tunnelPort: entry.tunnel.describe().localPort,
          privateKey: readFileSync(entry.keyFile, 'utf8'),
          username: config.sshUser,
          dir: entry.bridge?.dir || config.sftpBridgeDir || DEFAULT_BRIDGE_DIR,
          remotePort: config.sftpBridgePort,
        })
        if (args.action === 'stop') {
          const wasRunning = await stopBridge({
            tunnelPort: entry.tunnel.describe().localPort,
            privateKey: readFileSync(entry.keyFile, 'utf8'),
            username: config.sshUser,
            dir: state_.dir,
            remotePort: config.sftpBridgePort,
          })
          await entry.tunnel.removeForward(config.sftpBridgePort).catch(() => {})
          entry.bridge = null
          return {
            text: `SFTP bridge of ${entry.label || entry.wsId}: ${wasRunning ? 'stopped' : 'was not running'}. The endpoint now serves exec only; reconnect to bring SFTP back.`,
          }
        }
        return {
          text: [
            `SFTP bridge of ${entry.label || entry.wsId} [${entry.wsId}]`,
            `directory: ${state_.dir}`,
            `ssh2 installed: ${state_.installed ? 'yes' : 'no'}`,
            `daemon: ${state_.running ? `running (pid ${state_.pid})` : 'not running'}`,
            `listening inside the dev space on port ${config.sftpBridgePort}: ${state_.listening ? 'yes' : 'no'}`,
            entry.bridge ? `forwarded here as 127.0.0.1:${entry.bridge.localPort}` : 'not forwarded in this session',
            state_.logTail ? `log:\n${state_.logTail}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)

  // ── human command ─────────────────────────────────────────────────────────

  ctx.commands.register({
    name: 'bas',
    description:
      'SAP Business Application Studio remote dev spaces (status | login | logout | devspaces | start | stop | connect | disconnect | bridge | ports)',
    input: {
      hint: 'status | login <landscape> | devspaces [landscape] | start <dev space> | stop <dev space> | connect <dev space> | disconnect [dev space] | bridge [dev space] | ports [set <wsId> <drop> <bridge>|clear <wsId>] | logout <landscape>',
    },
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
                    `${space.sshEnabled === true ? '[ssh]' : space.sshEnabled === false ? '[ ! ]' : '[ ? ]'} ${space.status.padEnd(8)} ${space.label || '(unnamed)'} [${space.id}]`,
                )
                .join('\n'),
            }
          }
          case 'start': {
            const result = await startDevSpaceFlow({ devSpace: argument })
            const name = devSpaceName(result.space)
            return {
              kind: 'success',
              text: result.alreadyRunning
                ? `${name} is already RUNNING.`
                : `${name} is ${result.space.status}. Connect it with /bas connect ${result.space.id}.`,
            }
          }
          case 'stop': {
            const result = await stopDevSpaceFlow({ devSpace: argument })
            const name = devSpaceName(result.space)
            return {
              kind: 'success',
              text: result.alreadyStopped ? `${name} is already STOPPED.` : `${name} is ${result.space.status}.`,
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
                entry.bridge
                  ? `sftp + exec: rw_connect host=127.0.0.1 port=${entry.bridge.localPort} username=${config.sshUser} privateKeyPath=${entry.keyFile}`
                  : 'sftp: unavailable (the dev space sshd has no sftp-server and the bridge is off or failed)',
                ...sshPublishLines(entry.ssh ?? { written: false, reason: 'nothing published', block: '', section: entry.section }),
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
          case 'bridge': {
            const [, entry] = findTunnel(argument)
            const state_ = await bridgeState({
              tunnelPort: entry.tunnel.describe().localPort,
              privateKey: readFileSync(entry.keyFile, 'utf8'),
              username: config.sshUser,
              dir: entry.bridge?.dir || config.sftpBridgeDir || DEFAULT_BRIDGE_DIR,
              remotePort: config.sftpBridgePort,
            })
            return {
              kind: 'success',
              text: [
                `SFTP bridge of ${entry.label || entry.wsId} [${entry.wsId}]`,
                `directory: ${state_.dir}`,
                `ssh2 installed: ${state_.installed ? 'yes' : 'no'}`,
                `daemon: ${state_.running ? `running (pid ${state_.pid})` : 'not running'}`,
                `listening inside the dev space on port ${config.sftpBridgePort}: ${state_.listening ? 'yes' : 'no'}`,
                entry.bridge ? `forwarded here as 127.0.0.1:${entry.bridge.localPort}` : 'not forwarded in this session',
                state_.logTail ? `log:\n${state_.logTail}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            }
          }
          case 'ports': {
            // Parse: /bas ports [set|clear] [wsId] [dropbear] [bridge]
            const parts = argument.split(/\s+/).filter(Boolean)
            if (parts[0] === 'set' && parts.length >= 4) {
              const wsId = parts[1]
              const dropbear = parseInt(parts[2]) || 0
              const bridge = parseInt(parts[3]) || 0
              state.forwardPorts[wsId] = { dropbear, bridge }
              persist()
              return { kind: 'success', text: `Set ports for ${wsId}: dropbear=${dropbear}, bridge=${bridge}` }
            }
            if (parts[0] === 'clear' && parts.length >= 2) {
              const wsId = parts[1]
              delete state.forwardPorts[wsId]
              persist()
              return { kind: 'success', text: `Cleared port assignment for ${wsId}` }
            }
            // Show all ports
            const allPorts = { ...config.forwardPorts, ...state.forwardPorts }
            const entries = Object.entries(allPorts)
            if (entries.length === 0) {
              return { kind: 'success', text: 'No fixed port assignments. All dev spaces use random ports.\n\nUsage: /bas ports set <wsId> <dropbearPort> <bridgePort>' }
            }
            const lines = entries.map(([wsId, ports]) => {
              const dropbear = ports.dropbear || 'random'
              const bridge = ports.bridge || 'random'
              return `  ${wsId}: dropbear=${dropbear}, bridge=${bridge}`
            })
            return {
              kind: 'success',
              text: [
                'Fixed port assignments:',
                ...lines,
                '',
                `Strict mode: ${config.forwardPortsStrict ? 'on (error if port occupied)' : 'off (fallback to random)'}`,
                '',
                'Usage: /bas ports set <wsId> <dropbearPort> <bridgePort>',
                '       /bas ports clear <wsId>',
              ].join('\n'),
            }
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
              text: `unknown subcommand "${subcommand}"; use status, login, logout, forget, devspaces, start, stop, connect or disconnect`,
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
        ssh: entry.ssh ?? null,
        sftp: entry.bridge
          ? { localPort: entry.bridge.localPort, remotePort: entry.bridge.remotePort, pid: entry.bridge.pid, dir: entry.bridge.dir }
          : null,
        ...entry.tunnel.describe(),
      })),
      forwardPorts: { ...config.forwardPorts, ...state.forwardPorts },
      forwardPortsStrict: config.forwardPortsStrict,
      sshConfigPath: paths.configPath,
      sshConfigMode: sshConfigMode(),
      sshFragmentPath: sshFragmentPath(),
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
      path: '/bas-remote/devspace',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const action = String(body.action ?? '').toLowerCase()
          // The Web UI keeps polling the dev-space list itself, so it does not
          // wait here; the tools and /bas do wait for a final status.
          if (action === 'start') {
            const result = await startDevSpaceFlow({
              landscape: body.landscape,
              devSpace: body.devSpace,
              wait: false,
            })
            return sendJson(res, 200, { ok: true, devSpace: result.space })
          }
          if (action === 'stop') {
            const result = await stopDevSpaceFlow({
              landscape: body.landscape,
              devSpace: body.devSpace,
              wait: false,
            })
            return sendJson(res, 200, { ok: true, devSpace: result.space })
          }
          sendJson(res, 400, { ok: false, error: `unknown action "${body.action}"; use start or stop` })
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
              ssh: entry.ssh ?? null,
              sftp: entry.bridge
                ? { localPort: entry.bridge.localPort, remotePort: entry.bridge.remotePort, pid: entry.bridge.pid, dir: entry.bridge.dir }
                : null,
              ...description,
            },
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/bas-remote/ports',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          // Update state.forwardPorts with the new values
          if (body.forwardPorts && typeof body.forwardPorts === 'object') {
            state.forwardPorts = { ...state.forwardPorts, ...body.forwardPorts }
            // Remove entries with null values
            for (const [key, value] of Object.entries(state.forwardPorts)) {
              if (value === null || value === undefined) {
                delete state.forwardPorts[key]
              }
            }
            persist()
          }
          sendJson(res, 200, {
            ok: true,
            forwardPorts: state.forwardPorts,
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
        unpublishSshEntry(entry)
      }
      tunnels.clear()
    },
    'dsh-bas-remote.teardown',
  )
}
