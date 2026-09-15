// dsh-bas-remote — SAP Business Application Studio (BAS) landscape client.
//
// This file re-implements, in plain Node.js, the calls that the SAP
// `app-studio-toolkit` "Remote Access for SAP Business Application Studio"
// extension makes through `@sap/bas-sdk`:
//
//   * the `<landscape>/ext-login.html` browser hand-off: the landscape login
//     page POSTs `{ jwt, iasjwt }` back to a loopback HTTP listener,
//   * `GET <landscape>/ws-manager/api/v1/workspace`      — list dev spaces,
//   * `GET <landscape>/ws-manager/api/v1/workspace/<id>` — one dev space,
//   * `GET <dev-space startup URL>/key`                  — the SSH private key.
//
// Reference implementation:
//   packages/app-studio-remote-access/src/authentication/auth-utils.ts
//   packages/app-studio-toolkit/src/authentication/authProvider.ts
//   @sap/bas-sdk  src/utils/devspace-utils.ts (getDevSpace/getDevSpaces/getKey)
//                 src/apis/get-devspace.ts     (flattenDevspaceInfo)
//                 src/utils/core-utils.ts      (getExtLoginPath)

import { createServer } from 'node:http'
import { createHash, randomBytes, randomInt } from 'node:crypto'

/** BAS dev-channel SSH-over-WebSocket socket port (see the extension's ssh-utils.ts). */
export const SSHD_SOCKET_PORT = 33765
/** BAS dev-channel SSH-over-WebSocket TCP port. */
export const SSH_SOCKET_PORT = 443
/** Local `ws-manager` API prefix of a BAS landscape. */
export const WS_MANAGER_PATH = '/ws-manager/api/v1'
/** Default port the landscape login page posts the JWT back to. */
export const DEFAULT_LOGIN_PORT = 55532

/**
 * Accept `host`, `https://host`, `https://host/` or a full BAS view URL and
 * return `https://host` without a trailing slash.
 * @param {string} input - user-supplied landscape reference.
 * @returns {string} normalized landscape origin.
 */
export function normalizeLandscape(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('landscape URL is required')
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  url.protocol = 'https:'
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  url.username = ''
  url.password = ''
  return url.toString().replace(/\/+$/, '')
}

/** @param {string} landscape - normalized landscape origin. @returns {string} host[:port]. */
export function landscapeHost(landscape) {
  return new URL(landscape).host
}

/** @param {string} landscape - normalized landscape origin. @returns {string} short display name. */
export function landscapeLabel(landscape) {
  return new URL(landscape).hostname.split('.')[0] || landscapeHost(landscape)
}

/** Readable prefix kept when slugging a landscape host into a key segment. */
const KEY_SLUG_LIMIT = 32

/**
 * A credential-store-safe id for one landscape.
 *
 * Credential keys are `<scope>/<id>` and both halves must match
 * `^[a-z][a-z0-9-]*$` (see `@deepseek-ai/dsh-credentials`), which a landscape
 * host never does: BAS hosts are dotted and often start with a digit
 * (`3fb23b87trial.ap21cf.trial.applicationstudio.cloud.sap`). The host is
 * therefore slugged into that alphabet and suffixed with a short digest of the
 * exact host, so distinct hosts stay distinct even when they slug alike
 * (`a.b` vs `a-b`) and the id is stable across runs.
 * @param {string} landscape - normalized landscape origin.
 * @returns {string} a valid credential key id segment.
 */
export function landscapeCredentialId(landscape) {
  const host = landscapeHost(landscape).toLowerCase()
  const slug = host
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KEY_SLUG_LIMIT)
    .replace(/-+$/, '')
  const digest = createHash('sha256').update(host).digest('hex').slice(0, 8)
  const base = slug ? `${slug}-${digest}` : digest
  return /^[a-z]/.test(base) ? base : `ls-${base}`
}

/**
 * The external-login page, mirroring `core.getExtLoginPath()`.
 * @param {string} landscape - normalized landscape origin.
 * @param {boolean} [useVscodeProtocol] - use the `remote-login.html` variant.
 * @returns {string} the URL to open in a browser.
 */
export function extLoginUrl(landscape, useVscodeProtocol = false) {
  const url = new URL(landscape)
  url.protocol = 'https:'
  url.pathname = `${useVscodeProtocol ? 'remote' : 'ext'}-login.html`
  url.search = `cb=${randomInt(0, 100000)}`
  return url.toString()
}

/**
 * Decode the payload of a JWT without verifying it.
 * @param {string} token - compact JWS.
 * @returns {object|null} decoded payload, or null when unreadable.
 */
export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1]
    if (!part) return null
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Milliseconds until the JWT expires, or null when it carries no `exp`.
 * @param {string} token - compact JWS.
 * @returns {number|null} remaining lifetime in milliseconds.
 */
export function jwtRemainingMs(token) {
  const payload = decodeJwt(token)
  if (!payload || typeof payload.exp !== 'number') return null
  return payload.exp * 1000 - Date.now()
}

/**
 * Whether a stored JWT is still usable.
 * @param {string} token - compact JWS.
 * @param {number} [skewMs] - treat tokens expiring sooner than this as expired.
 * @returns {boolean} true when the token exists and has not expired.
 */
export function isJwtUsable(token, skewMs = 60000) {
  if (!token) return false
  const remaining = jwtRemainingMs(token)
  if (remaining === null) return true
  return remaining > skewMs
}

function authHeaders(jwt) {
  return {
    'x-approuter-authorization': `bearer ${jwt}`,
    authorization: `bearer ${jwt}`,
    'user-agent': 'Bas',
    accept: 'application/json, text/plain, */*',
  }
}

async function readError(response) {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 400).replace(/\s+/g, ' ').trim()
  } catch {
    detail = ''
  }
  return `HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`
}

async function getJson(url, jwt) {
  const response = await fetch(url, { method: 'GET', headers: authHeaders(jwt) })
  if (!response.ok) {
    throw new Error(`${url} responded ${await readError(response)}`)
  }
  return response.json()
}

/**
 * One flattened dev space, shaped like `@sap/bas-sdk`'s `DevspaceInfo`.
 * @typedef {object} DevSpace
 * @property {string} id
 * @property {string} label
 * @property {string} status
 * @property {string} url - runtime base URL (the dev-channel WebSocket host).
 * @property {string} startupUrl - runtime startup URL serving `/key`.
 * @property {boolean|null} sshEnabled - null until the key endpoint was probed.
 * @property {string} pack
 * @property {string} packDisplayName
 * @property {string} origin
 */

/**
 * Flatten one `ws-manager/api/v1/workspace` entry, mirroring `flattenDevspaceInfo`.
 *
 * SSH availability is *not* decided here: BAS dev spaces serve their SSH key
 * from the runtime startup URL whether or not any remote-access extension is
 * listed in `annotations.optionalExtensions`, so the only reliable answer comes
 * from probing that endpoint (`probeDevSpaceSsh`).
 * @param {object} entry - raw workspace record.
 * @returns {DevSpace} flattened dev space.
 */
export function flattenDevSpace(entry) {
  const labels = entry?.config?.labels ?? {}
  const annotations = entry?.config?.annotations ?? {}
  return {
    id: entry?.config?.id ?? '',
    label: labels['ws-manager.devx.sap.com/displayname'] ?? '',
    status: entry?.runtime?.status ?? 'UNKNOWN',
    url: entry?.runtime?.baseUrl ?? '',
    startupUrl: entry?.runtime?.url?.startup ?? '',
    sshEnabled: null,
    pack: annotations.pack ?? '',
    packDisplayName: annotations.packTagline ?? '',
    origin: entry?.devSpaceOriginLabel ?? labels['ws-manager.devx.sap.com/LCAP'] ?? '',
  }
}

/** @param {DevSpace} space - flattened dev space. @returns {string} its `/key` URL, or ''. */
export function devSpaceKeyUrl(space) {
  if (!space.startupUrl) return ''
  const url = new URL(space.startupUrl)
  url.pathname = 'key'
  url.search = ''
  return url.toString()
}

/**
 * Probe whether a dev space serves its SSH private key.
 *
 * This replaces an annotation heuristic that produced false negatives: a dev
 * space whose `optionalExtensions` lists no remote-access extension still
 * answers `GET <startup>/key` with an OpenSSH key when it is RUNNING.
 * @param {DevSpace} space - flattened dev space.
 * @param {string} jwt - landscape JSON Web Token.
 * @returns {Promise<boolean>} true when the key endpoint answered with a key.
 */
export async function probeDevSpaceSsh(space, jwt) {
  const url = devSpaceKeyUrl(space)
  if (!url) return false
  try {
    const response = await fetch(url, { method: 'GET', headers: authHeaders(jwt) })
    if (!response.ok) return false
    const body = await response.text()
    return body.includes('PRIVATE KEY')
  } catch {
    return false
  }
}

/**
 * List the dev spaces of a landscape.
 * @param {string} landscape - normalized landscape origin.
 * @param {string} jwt - landscape JSON Web Token.
 * @returns {Promise<DevSpace[]>} dev spaces in landscape order.
 */
export async function listDevSpaces(landscape, jwt) {
  const url = `${landscape}${WS_MANAGER_PATH}/workspace`
  const data = await getJson(url, jwt)
  const entries = Array.isArray(data) ? data : (data?.workspaces ?? [])
  return entries.map(flattenDevSpace)
}

/**
 * Read one dev space record.
 * @param {string} landscape - normalized landscape origin.
 * @param {string} jwt - landscape JSON Web Token.
 * @param {string} wsId - dev space id.
 * @returns {Promise<object>} raw workspace record.
 */
export async function getDevSpaceRecord(landscape, jwt, wsId) {
  return getJson(`${landscape}${WS_MANAGER_PATH}/workspace/${encodeURIComponent(wsId)}`, jwt)
}

/** Runtime status a dev space reports while it is usable. */
export const DEV_SPACE_RUNNING = 'RUNNING'

/**
 * Start or stop one dev space, mirroring `@sap/bas-sdk`'s `updateDevSpace()`
 * (which the toolkit's Dev Space Manager drives for its start/stop actions).
 *
 * `PUT <landscape>/ws-manager/api/v1/workspace/<id>` with
 * `{ Suspended, WorkspaceDisplayName }`: `Suspended: false` starts (resumes) the
 * dev space, `Suspended: true` stops (suspends) it.
 * @param {string} landscape - normalized landscape origin.
 * @param {string} jwt - landscape JSON Web Token.
 * @param {string} wsId - dev space id.
 * @param {boolean} suspended - true to stop the dev space, false to start it.
 * @param {string} [displayName] - dev space display name the API expects back.
 * @returns {Promise<void>} resolves once the landscape accepted the change.
 */
export async function setDevSpaceSuspended(landscape, jwt, wsId, suspended, displayName = '') {
  const url = `${landscape}${WS_MANAGER_PATH}/workspace/${encodeURIComponent(wsId)}`
  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...authHeaders(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({ Suspended: Boolean(suspended), WorkspaceDisplayName: String(displayName ?? '') }),
  })
  if (!response.ok) {
    throw new Error(`${url} responded ${await readError(response)}`)
  }
}

/**
 * Start (resume) one dev space and return as soon as the landscape accepted it.
 * @param {string} landscape - normalized landscape origin.
 * @param {string} jwt - landscape JSON Web Token.
 * @param {string} wsId - dev space id.
 * @param {string} [displayName] - dev space display name.
 * @returns {Promise<void>} resolves once the start request was accepted.
 */
export async function startDevSpace(landscape, jwt, wsId, displayName = '') {
  return setDevSpaceSuspended(landscape, jwt, wsId, false, displayName)
}

/**
 * Stop (suspend) one dev space and return as soon as the landscape accepted it.
 * @param {string} landscape - normalized landscape origin.
 * @param {string} jwt - landscape JSON Web Token.
 * @param {string} wsId - dev space id.
 * @param {string} [displayName] - dev space display name.
 * @returns {Promise<void>} resolves once the stop request was accepted.
 */
export async function stopDevSpace(landscape, jwt, wsId, displayName = '') {
  return setDevSpaceSuspended(landscape, jwt, wsId, true, displayName)
}

/** @param {number} ms - milliseconds to wait. @returns {Promise<void>} resolves after the delay. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Poll one dev space until `accept` holds, mirroring how the toolkit re-reads a
 * dev space after it asks the landscape to start or stop it. Start/stop is
 * asynchronous on the BAS side, so a single re-read is not enough.
 * @param {string} landscape - normalized landscape origin.
 * @param {string} jwt - landscape JSON Web Token.
 * @param {string} wsId - dev space id.
 * @param {(space: object) => boolean} accept - predicate over the flattened dev space.
 * @param {object} [options] - polling options.
 * @param {number} [options.timeoutMs] - give up after this long.
 * @param {number} [options.intervalMs] - delay between reads.
 * @returns {Promise<object>} the last observed flattened dev space.
 */
export async function waitForDevSpaceStatus(landscape, jwt, wsId, accept, { timeoutMs = 240000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let last = flattenDevSpace(await getDevSpaceRecord(landscape, jwt, wsId))
  while (!accept(last) && Date.now() < deadline) {
    await delay(intervalMs)
    last = flattenDevSpace(await getDevSpaceRecord(landscape, jwt, wsId))
  }
  return last
}

/**
 * Fetch the dev-space SSH private key, mirroring `remotessh.getKey()`.
 *
 * The key is served from the dev space's own `startup` runtime URL, not from
 * the landscape, so the request goes to `new URL('<startup>')` with its path
 * replaced by `/key`.
 * @param {string} landscape - normalized landscape origin.
 * @param {string} jwt - landscape JSON Web Token.
 * @param {string} wsId - dev space id.
 * @returns {Promise<{ key: string, wsUrl: string, record: object }>} PEM key and runtime URL.
 */
export async function getDevSpaceKey(landscape, jwt, wsId) {
  const record = await getDevSpaceRecord(landscape, jwt, wsId)
  const wsUrl = record?.runtime?.baseUrl ?? ''
  const startupUrl = record?.runtime?.url?.startup ?? ''
  if (!startupUrl) {
    const status = record?.runtime?.status ?? 'UNKNOWN'
    throw new Error(
      status === DEV_SPACE_RUNNING
        ? 'the dev space exposes no startup URL; enable the "Remote Access" (SSH) extension in the dev space first'
        : `the dev space is ${status} and exposes no startup URL; start it first (bas_start) and retry`,
    )
  }
  const keyUrl = new URL(startupUrl)
  keyUrl.pathname = 'key'
  keyUrl.search = ''
  const response = await fetch(keyUrl.toString(), { method: 'GET', headers: authHeaders(jwt) })
  if (!response.ok) {
    throw new Error(`the dev space key endpoint responded ${await readError(response)}`)
  }
  const body = await response.text()
  let key = body
  try {
    const parsed = JSON.parse(body)
    if (typeof parsed === 'string') key = parsed
    else if (parsed && typeof parsed.key === 'string') key = parsed.key
    else if (parsed && typeof parsed.value === 'string') key = parsed.value
  } catch {
    // Plain-text key: keep the body as-is.
  }
  key = String(key).trim()
  if (!key.includes('PRIVATE KEY')) {
    throw new Error('the dev space key endpoint returned something that is not a PEM private key')
  }
  return { key: `${key}\n`, wsUrl, record }
}

/**
 * A one-shot loopback listener that completes the landscape login hand-off.
 *
 * The landscape's login page (opened by the caller) POSTs the JWT to
 * `http://<host>:<port>/ext-login`; this server resolves with the payload.
 */
export class LoginListener {
  /**
   * @param {object} [options] - listener options.
   * @param {string} [options.host] - interface to bind.
   * @param {number} [options.port] - TCP port; 0 picks a free one.
   */
  constructor({ host = '127.0.0.1', port = DEFAULT_LOGIN_PORT } = {}) {
    this.host = host
    this.port = port
    this.server = null
    this.settled = false
    this.resolve = null
    this.reject = null
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // Nothing awaits the rejection path until login() does; keep Node quiet.
    this.promise.catch(() => {})
  }

  /** @returns {number} the actually bound port. */
  get boundPort() {
    return this.server?.address()?.port ?? this.port
  }

  /** Start listening. @returns {Promise<void>} resolves once bound. */
  async start() {
    this.server = createServer((req, res) => this.#handle(req, res))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
  }

  #handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname !== '/ext-login') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('dsh-bas-remote: not found')
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let payload = null
      try {
        payload = JSON.parse(body)
      } catch {
        payload = Object.fromEntries(new URLSearchParams(body))
      }
      const jwt = payload?.jwt
      const iasjwt = payload?.iasjwt ?? ''
      if (!jwt || String(jwt).startsWith('<html>')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"error"}')
        this.#settle(new Error('the landscape returned an unusable token'))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
      this.#settle(null, { jwt: String(jwt), iasjwt: String(iasjwt) })
    })
    req.on('error', (error) => this.#settle(error))
  }

  #settle(error, value) {
    if (this.settled) return
    this.settled = true
    if (error) this.reject(error)
    else this.resolve(value)
  }

  /** Wait for the hand-off. @param {number} [timeoutMs] - give up after this long. @returns {Promise<{jwt: string, iasjwt: string}>} */
  async wait(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return this.promise
    let timer
    try {
      return await Promise.race([
        this.promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no login response within ${Math.round(timeoutMs / 1000)}s`)),
            timeoutMs,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Close the socket and reject a pending wait. */
  close() {
    this.#settle(new Error('login listener closed'))
    const server = this.server
    this.server = null
    if (server) {
      try {
        server.close()
      } catch {
        // Already closed.
      }
    }
  }
}

/** @returns {string} a short random id usable as a file/record key. */
export function shortId() {
  return randomBytes(4).toString('hex')
}
