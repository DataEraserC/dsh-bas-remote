// dsh-bas-remote — SSH key and `~/.ssh/config` management.
//
// The dev channel exposes the dev space's sshd on a random loopback port, so
// the endpoint must be (re)published to `~/.ssh/config` on every connect. Each
// entry is written as a delimited block:
//
//     # >>> dsh-bas-remote <landscape-host>.<dev-space-id>
//     Host <landscape-host>.<dev-space-id>
//       HostName 127.0.0.1
//       Port <loopback port>
//       User user
//       IdentityFile <key file>
//       NoHostAuthenticationForLocalhost yes
//     # <<< dsh-bas-remote <landscape-host>.<dev-space-id>
//
// Only these blocks are ever touched: the rest of the file, including comments
// and ordering, is preserved verbatim.

import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** @returns {string} the default SSH directory. */
export function defaultSshDir() {
  return join(homedir(), '.ssh')
}

/** @returns {string} the default SSH config file. */
export function defaultSshConfigPath() {
  return join(defaultSshDir(), 'config')
}

/**
 * The fragment this plugin owns when it must not touch `~/.ssh/config`
 * (a nix/home-manager managed file is usually not writable, and any write
 * would be reverted on the next switch).
 * @returns {string} the default fragment path.
 */
export function defaultSshFragmentPath() {
  return join(defaultSshDir(), 'dsh-bas-remote.conf')
}

/**
 * Why an SSH config file must not be written, if it must not.
 * A symlink (nix store, home-manager) or an unwritable file is left alone.
 * @param {string} path - file about to be (re)written.
 * @returns {string|null} a reason to skip, or null when writing is safe.
 */
export function sshConfigWriteGuard(path) {
  let stats = null
  try {
    stats = lstatSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') return `${path} cannot be inspected (${error.message})`
    try {
      accessSync(dirname(path), constants.W_OK)
    } catch {
      return `${dirname(path)} is not writable`
    }
    return null
  }
  if (stats.isSymbolicLink()) return `${path} is a symlink (managed elsewhere)`
  if (!stats.isFile()) return `${path} is not a regular file`
  try {
    accessSync(path, constants.W_OK)
  } catch {
    return `${path} is not writable`
  }
  return null
}

/**
 * Render the `Host` block for one dev space — the same text that is written
 * into a config file, so it can also be pasted into a managed one.
 * @param {object} options - block options.
 * @param {string} options.section - `Host` alias.
 * @param {string} options.identityFile - private-key path.
 * @param {number} options.port - loopback port serving the dev space sshd.
 * @param {string} [options.user] - SSH user.
 * @param {string} [options.hostName] - forwarded host (default `127.0.0.1`).
 * @param {boolean} [options.markers] - wrap the block in this plugin's markers.
 * @returns {string} the `Host` block.
 */
export function sshConfigBlock({ section, identityFile, port, user = 'user', hostName = '127.0.0.1', markers = false }) {
  const lines = []
  if (markers) lines.push(BLOCK_START(section))
  lines.push(
    `Host ${section}`,
    `  HostName ${hostName}`,
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${identityFile}`,
    '  NoHostAuthenticationForLocalhost yes',
  )
  if (markers) lines.push(BLOCK_END(section))
  return lines.join('\n')
}

/**
 * Resolve the effective SSH paths, honouring explicit overrides.
 * @param {object} [options] - path overrides.
 * @param {string} [options.sshConfigPath] - explicit config file path.
 * @param {string} [options.sshDir] - explicit key directory.
 * @returns {{configPath: string, dir: string}} resolved paths.
 */
export function resolveSshPaths({ sshConfigPath = '', sshDir = '' } = {}) {
  const configPath = sshConfigPath || defaultSshConfigPath()
  return { configPath, dir: sshDir || dirname(configPath) }
}

/**
 * The `Host` alias used for one dev space, matching the SAP extension:
 * `<landscape host>.<dev space id>`.
 * @param {string} landscapeHost - `host[:port]` of the landscape.
 * @param {string} wsId - dev space id.
 * @returns {string} the SSH host alias.
 */
export function sshHostAlias(landscapeHost, wsId) {
  return `${landscapeHost}.${wsId}`
}

/**
 * The private-key file name used for one dev space, matching the SAP
 * extension: `<dev space host>.key` inside the SSH directory.
 * @param {string} dir - SSH directory.
 * @param {string} wsUrl - dev-space runtime base URL.
 * @returns {string} absolute key path.
 */
export function keyFilePath(dir, wsUrl) {
  const host = new URL(wsUrl).host
  return join(dir, `${host}.key`)
}

/**
 * Write a private key with owner-only permissions.
 * @param {string} file - destination path.
 * @param {string} key - PEM private key.
 * @returns {string} the path written.
 */
export function writeKeyFile(file, key) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
  writeFileSync(temp, key, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
  return file
}

/**
 * Delete a key file, ignoring absence.
 * @param {string} file - key path.
 * @returns {boolean} whether a file was removed.
 */
export function removeKeyFile(file) {
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

const BLOCK_START = (section) => `# >>> dsh-bas-remote ${section}`
const BLOCK_END = (section) => `# <<< dsh-bas-remote ${section}`

function readConfig(path) {
  if (!existsSync(path)) return { text: '', existed: false }
  return { text: readFileSync(path, 'utf8'), existed: true }
}

function writeConfig(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.dsh-bas-remote.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

function stripBlock(text, section) {
  const start = BLOCK_START(section)
  const end = BLOCK_END(section)
  const lines = text.split('\n')
  const kept = []
  let skipping = false
  let removed = false
  for (const line of lines) {
    if (!skipping && line.trim() === start) {
      skipping = true
      removed = true
      continue
    }
    if (skipping) {
      if (line.trim() === end) skipping = false
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), removed }
}

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

/**
 * Create or refresh the managed block for one dev space.
 * @param {object} options - entry options.
 * @param {string} options.configPath - SSH config file.
 * @param {string} options.section - `Host` alias.
 * @param {string} options.identityFile - private-key path.
 * @param {number} options.port - loopback port serving the dev space sshd.
 * @param {string} options.user - SSH user.
 * @param {string} [options.hostName] - forwarded host (default `127.0.0.1`).
 * @param {string} [options.header] - comment block used when the file is created.
 * @returns {{changed: boolean, entry: string}} whether the file changed.
 */
export function upsertSshConfigEntry({
  configPath,
  section,
  identityFile,
  port,
  user,
  hostName = '127.0.0.1',
  header = '',
}) {
  const { text, existed } = readConfig(configPath)
  const stripped = stripBlock(text, section)
  const block = `${sshConfigBlock({ section, identityFile, port, user, hostName, markers: true })}\n`
  const base = collapseBlankLines(stripped.text)
  const prefix = existed || base !== '' ? '' : header
  const next = `${prefix}${base}${base.endsWith('\n') || base === '' ? '' : '\n'}${block}`
  if (existed && next === text) return { changed: false, entry: block }
  writeConfig(configPath, next)
  return { changed: true, entry: block }
}

/**
 * Remove the managed block for one dev space.
 * @param {object} options - removal options.
 * @param {string} options.configPath - SSH config file.
 * @param {string} options.section - `Host` alias.
 * @returns {boolean} whether the file changed.
 */
export function removeSshConfigEntry({ configPath, section }) {
  const { text, existed } = readConfig(configPath)
  if (!existed) return false
  const stripped = stripBlock(text, section)
  if (!stripped.removed) return false
  writeConfig(configPath, collapseBlankLines(stripped.text))
  return true
}

/**
 * Publish one dev-space endpoint into a target file, refusing to touch a file
 * that is a symlink or not writable (nix/home-manager managed configs).
 * @param {object} options - publish options.
 * @param {string} options.target - file to write.
 * @param {string} options.section - `Host` alias.
 * @param {string} options.identityFile - private-key path.
 * @param {number} options.port - loopback port serving the dev space sshd.
 * @param {string} [options.user] - SSH user.
 * @param {string} [options.header] - comment block used when the file is created.
 * @returns {{section: string, written: boolean, target: string, reason: string, block: string}}
 */
export function publishSshEndpoint({ target, section, identityFile, port, user = 'user', header = '' }) {
  const block = sshConfigBlock({ section, identityFile, port, user })
  const guard = sshConfigWriteGuard(target)
  if (guard) return { section, written: false, target, reason: guard, block }
  try {
    upsertSshConfigEntry({ configPath: target, section, identityFile, port, user, header })
    return { section, written: true, target, reason: '', block }
  } catch (error) {
    return { section, written: false, target, reason: error.message, block }
  }
}

/**
 * Remove the managed block of one dev space from a file.
 * @param {object} options - removal options.
 * @param {string} options.target - file to edit.
 * @param {string} options.section - `Host` alias.
 * @returns {boolean} whether the file changed.
 */
export function unpublishSshEndpoint({ target, section }) {
  return removeSshConfigEntry({ configPath: target, section })
}

/**
 * List the `Host` aliases this plugin manages in a config file.
 * @param {string} configPath - SSH config file.
 * @returns {string[]} managed sections, in file order.
 */
export function listManagedEntries(configPath) {
  const { text } = readConfig(configPath)
  const prefix = '# >>> dsh-bas-remote '
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith(prefix))
    .map((line) => line.trim().slice(prefix.length))
}

/**
 * Read the `Port` of one managed block.
 * @param {string} configPath - SSH config file.
 * @param {string} section - `Host` alias.
 * @returns {number|null} the recorded port.
 */
export function readManagedPort(configPath, section) {
  const { text } = readConfig(configPath)
  const lines = text.split('\n')
  let inside = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === BLOCK_START(section)) {
      inside = true
      continue
    }
    if (inside && trimmed === BLOCK_END(section)) return null
    if (inside) {
      const match = /^Port\s+(\d+)$/.exec(trimmed)
      if (match) return Number(match[1])
    }
  }
  return null
}

/**
 * Whether a path is a regular file (used for status reporting).
 * @param {string} path - path to test.
 * @returns {boolean} true when it is a file.
 */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
