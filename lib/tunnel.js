// dsh-bas-remote — BAS dev-channel tunnel.
//
// A BAS dev space is reachable from a local IDE over a WebSocket that carries
// an SSH transport ("dev channel"). The tunnel has two layers, exactly as in
// the SAP `app-studio-remote-access` extension:
//
//   1. an SSH client session over `wss://port33765-<dev-space-host>:443`
//      (sub-protocol `ssh`, `Authorization: bearer <landscape JWT>`) that is
//      authenticated without credentials, and
//   2. a *local* TCP listener forwarded over that session to the dev space's
//      own sshd at `127.0.0.1:2222`.
//
// The result is a plain SSH endpoint on loopback that any SSH client — the
// harness remote-workspace tools, `ssh`, `scp`, an IDE — can use with the
// private key returned by the landscape.
//
// Reference implementation:
//   packages/app-studio-remote-access/src/tunnel/ssh.ts
//   packages/app-studio-remote-access/src/tunnel/ssh-utils.ts

import { once } from 'node:events'
import WebSocket from 'ws'
import devTunnelsSsh from '@microsoft/dev-tunnels-ssh'
import devTunnelsSshTcp from '@microsoft/dev-tunnels-ssh-tcp'

import { SSHD_SOCKET_PORT, SSH_SOCKET_PORT } from './landscape.js'

const {
  SshAlgorithms,
  SshSessionConfiguration,
  SshProtocolExtensionNames,
  SshClientSession,
  SshDisconnectReason,
  WebSocketStream,
} = devTunnelsSsh
const { PortForwardingService } = devTunnelsSshTcp

/** The dev space's sshd, as seen from inside the dev space. */
export const DEV_SPACE_SSHD_HOST = '127.0.0.1'
/** The dev space's sshd port. */
export const DEV_SPACE_SSHD_PORT = 2222

/**
 * Open a `ws` WebSocket, translating handshake failures into readable errors.
 * @param {string} address - `wss://` URL.
 * @param {object} options - `ws` client options.
 * @returns {Promise<import('ws').WebSocket>} an open socket.
 */
function openWebSocket(address, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address, 'ssh', options)
    const onError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onUnexpected = (_req, response) => {
      cleanup()
      response.resume()
      const status = `${response.statusCode} ${response.statusMessage ?? ''}`.trim()
      reject(new Error(`dev-channel handshake rejected with HTTP ${status}`))
    }
    const onOpen = () => {
      cleanup()
      resolve(socket)
    }
    const cleanup = () => {
      socket.removeListener('error', onError)
      socket.removeListener('unexpected-response', onUnexpected)
      socket.removeListener('open', onOpen)
    }
    socket.once('error', onError)
    socket.once('unexpected-response', onUnexpected)
    socket.once('open', onOpen)
  })
}

/**
 * One live dev-space tunnel.
 *
 * `start()` resolves once the loopback listener is accepting connections; the
 * returned `localPort` plus {@link DEV_SPACE_SSHD_HOST} form the SSH endpoint.
 */
export class DevChannelTunnel {
  /**
   * @param {object} options - tunnel options.
   * @param {string} options.landscape - normalized landscape origin.
   * @param {string} options.jwt - landscape JWT authorising the dev channel.
   * @param {string} options.wsUrl - dev-space runtime base URL (`runtime.baseUrl`).
   * @param {number} [options.localPort] - loopback port; 0 picks a free one.
   * @param {string} [options.username] - SSH user presented to the dev channel.
   * @param {number} [options.connectTimeoutMs] - handshake timeout.
   * @param {(level: string, message: string) => void} [options.log] - diagnostics sink.
   */
  constructor({
    landscape,
    jwt,
    wsUrl,
    localPort = 0,
    username = 'user',
    connectTimeoutMs = 30000,
    log = () => {},
  }) {
    this.landscape = landscape
    this.jwt = jwt
    this.wsUrl = wsUrl
    this.requestedLocalPort = localPort
    this.username = username
    this.connectTimeoutMs = connectTimeoutMs
    this.log = log

    this.localPort = 0
    this.serverUri = ''
    this.socket = null
    this.session = null
    this.forwarder = null
    this.startedAt = null
    this.closedReason = ''
    this.closeWaiters = []
  }

  /**
   * Compute the dev-channel WebSocket URL for a dev-space runtime URL.
   * @param {string} wsUrl - dev-space runtime base URL.
   * @returns {string} `wss://port33765-<host>:443`.
   */
  static serverUriFor(wsUrl) {
    const host = new URL(wsUrl).hostname
    if (!host) throw new Error(`cannot derive a dev-channel host from "${wsUrl}"`)
    return `wss://port${SSHD_SOCKET_PORT}-${host}:${SSH_SOCKET_PORT}`
  }

  /** @returns {boolean} whether the tunnel currently carries traffic. */
  get active() {
    return Boolean(this.session && !this.session.isClosed && this.socket && this.socket.readyState === WebSocket.OPEN)
  }

  /**
   * Establish the dev channel and start the loopback forwarder.
   * @returns {Promise<{localPort: number, serverUri: string}>} the SSH endpoint.
   */
  async start() {
    this.serverUri = DevChannelTunnel.serverUriFor(this.wsUrl)
    this.log('debug', `opening dev channel ${this.serverUri}`)

    this.socket = await openWebSocket(this.serverUri, {
      headers: { Authorization: `bearer ${this.jwt}` },
      handshakeTimeout: this.connectTimeoutMs,
      perMessageDeflate: false,
      followRedirects: false,
    })
    this.socket.binaryType = 'arraybuffer'
    this.socket.on('close', (code, reason) => {
      const text = reason ? reason.toString() : ''
      this.#markClosed(`dev-channel socket closed (${code}${text ? `: ${text}` : ''})`)
    })
    this.socket.on('error', (error) => this.#markClosed(`dev-channel socket error: ${error.message}`))

    const config = new SshSessionConfiguration()
    config.keyExchangeAlgorithms.push(SshAlgorithms.keyExchange.ecdhNistp521Sha512)
    config.publicKeyAlgorithms.push(SshAlgorithms.publicKey.ecdsaSha2Nistp521)
    config.publicKeyAlgorithms.push(SshAlgorithms.publicKey.rsa2048)
    config.encryptionAlgorithms.push(SshAlgorithms.encryption.aes256Gcm)
    config.protocolExtensions.push(SshProtocolExtensionNames.sessionReconnect)
    config.protocolExtensions.push(SshProtocolExtensionNames.sessionLatency)
    config.addService(PortForwardingService)

    const session = new SshClientSession(config)
    this.session = session
    session.onAuthenticating((event) => {
      // The dev channel authorises the caller through the WebSocket bearer
      // token; the SSH layer performs no authentication of its own.
      event.authenticationPromise = Promise.resolve({})
    })
    session.onClosed((error) => {
      this.#markClosed(error ? `dev-channel SSH session closed: ${error.message}` : 'dev-channel SSH session closed')
    })

    await session.connect(new WebSocketStream(this.socket))
    const authenticated = await session.authenticateClient({ username: this.username, publicKeys: [] })
    if (!authenticated) {
      throw new Error('the dev channel rejected the SSH client authentication')
    }

    const forwarding = session.activateService(PortForwardingService)
    this.forwarder = await forwarding.forwardToRemotePort(
      '127.0.0.1',
      this.requestedLocalPort,
      DEV_SPACE_SSHD_HOST,
      DEV_SPACE_SSHD_PORT,
    )
    this.localPort = this.forwarder.localPort
    this.startedAt = Date.now()
    this.log('debug', `dev channel ready on 127.0.0.1:${this.localPort}`)
    return { localPort: this.localPort, serverUri: this.serverUri }
  }

  #markClosed(reason) {
    if (this.closedReason) return
    this.closedReason = reason
    this.log('debug', reason)
    const waiters = this.closeWaiters
    this.closeWaiters = []
    for (const waiter of waiters) waiter(reason)
  }

  /**
   * Close the forwarder, the SSH session and the socket.
   * @returns {Promise<void>} resolves once teardown has been requested.
   */
  async stop() {
    const socket = this.socket
    const session = this.session
    this.socket = null
    this.session = null
    try {
      await this.forwarder?.dispose?.()
    } catch {
      // The session may already be gone.
    }
    this.forwarder = null
    if (session && !session.isClosed) {
      try {
        await session.close(SshDisconnectReason.byApplication)
      } catch {
        // Ignore teardown races.
      }
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close()
      } catch {
        // Ignore teardown races.
      }
    }
    if (!this.closedReason) this.closedReason = 'closed by request'
    await Promise.race([once(this.socket ?? socket, 'close').catch(() => {}), new Promise((r) => setTimeout(r, 500))])
  }

  /** Wait until the tunnel drops on its own. @returns {Promise<string>} the close reason. */
  waitForClose() {
    if (this.closedReason) return Promise.resolve(this.closedReason)
    return new Promise((resolve) => this.closeWaiters.push(resolve))
  }

  /** @returns {object} a JSON-safe description of this tunnel. */
  describe() {
    return {
      serverUri: this.serverUri,
      localPort: this.localPort,
      username: this.username,
      sshHost: DEV_SPACE_SSHD_HOST,
      sshPort: DEV_SPACE_SSHD_PORT,
      active: this.active,
      startedAt: this.startedAt,
      closedReason: this.closedReason,
    }
  }
}
