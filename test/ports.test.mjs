// Tests for the host half's port-assignment routes (lib/index.js).
//
// The settings UI edits port assignments through `/bas-remote/ports` and reads
// them back through `/bas-remote/state`. The two must agree, and a deletion has
// to survive the merge with the config layer — otherwise the row reappears on
// the next poll no matter how many times it is removed.
//
// This drives the real plugin entry point with a stubbed cordis context that
// captures the registered routes, then calls the handlers directly. No server,
// no dev space. Run with `npm test`.

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME_DIR = mkdtempSync(join(tmpdir(), 'dsh-bas-ports-'))
process.env.DSH_HOME = HOME_DIR

const checks = []
/** @param {string} name - check name. @param {() => Promise<void>|void} body - assertions. */
async function check(name, body) {
  try {
    await body()
    checks.push(`ok   ${name}`)
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** @param {object} state - initial plugin state to seed. */
function seedState(state) {
  mkdirSync(join(HOME_DIR, 'bas-remote'), { recursive: true })
  writeFileSync(join(HOME_DIR, 'bas-remote', 'state.json'), JSON.stringify(state))
}

/** @returns {string} the persisted state. */
function persistedState() {
  return JSON.parse(readFileSync(join(HOME_DIR, 'bas-remote', 'state.json'), 'utf8'))
}

/**
 * Load the plugin and capture its HTTP routes.
 * @param {object} configOverrides - plugin config on top of the schema defaults.
 * @returns {Promise<{call: Function, snapshot: Function}>} route caller and state reader.
 */
async function loadPlugin(configOverrides = {}) {
  const mod = await import('../lib/index.js')
  const routes = new Map()

  const makeInner = () => ({
    get: (name) => (name === 'webServer'
      ? { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } }
      : undefined),
    effect: (execute) => { if (typeof execute === 'function') execute(); return () => {} },
  })

  const tools = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    commands: { register: () => {} },
    credentials: {
      readRecord: async () => undefined,
      modifyRecord: async () => {},
      deleteRecord: async () => {},
    },
    systemPrompt: { section: () => {} },
    effect: (execute) => { if (typeof execute === 'function') execute(); return () => {} },
    inject: (deps, callback) => callback(makeInner()),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }

  mod.apply(ctx, mod.Config(configOverrides))

  /** Call one route the way node:http would. */
  const call = async (path, method, body) => {
    const handler = routes.get(path)
    if (!handler) throw new Error(`route ${path} is not registered; registered: ${[...routes.keys()].join(', ')}`)
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = Object.assign(
      (function* () { for (const chunk of chunks) yield chunk })(),
      { method, url: path, headers: {} },
    )
    let status = 0
    let payload = ''
    const res = {
      set statusCode(value) { status = value },
      get statusCode() { return status },
      setHeader() {},
      end(value) { payload = value === undefined ? '' : String(value) },
    }
    await handler(req, res)
    return { status, body: payload ? JSON.parse(payload) : undefined }
  }

  const snapshot = async () => (await call('/bas-remote/state', 'GET')).body.state
  return { call, snapshot, tools }
}

const WS = 'ws-4gdt1'
const OTHER = 'ws-other'

// A legacy state file (no `removedForwardPorts`) must still load.
seedState({
  landscapes: [],
  lastDevSpace: WS,
  forwardPorts: { [WS]: { dropbear: 44000, bridge: 44001 } },
})

const plugin = await loadPlugin()

await check('a legacy state file without the tombstone list still loads', async () => {
  const state = await plugin.snapshot()
  assert.deepEqual(state.forwardPorts[WS], { dropbear: 44000, bridge: 44001 })
})

await check('an added assignment is persisted and reported', async () => {
  const response = await plugin.call('/bas-remote/ports', 'POST', {
    forwardPorts: { [OTHER]: { dropbear: 45000, bridge: 45001 } },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.forwardPorts[OTHER], { dropbear: 45000, bridge: 45001 })
  assert.deepEqual((await plugin.snapshot()).forwardPorts[OTHER], { dropbear: 45000, bridge: 45001 })
})

await check('a null tombstone deletes the assignment instead of merging it back', async () => {
  const response = await plugin.call('/bas-remote/ports', 'POST', { forwardPorts: { [OTHER]: null } })
  assert.equal(response.status, 200)
  assert.equal(response.body.forwardPorts[OTHER], undefined, 'the route still reports the deleted assignment')
  const state = await plugin.snapshot()
  assert.equal(state.forwardPorts[OTHER], undefined, 'the deleted assignment is still displayed')
  assert.equal(persistedState().forwardPorts[OTHER], undefined, 'the deletion was not persisted')
  assert.ok(
    persistedState().removedForwardPorts.includes(OTHER),
    'the deletion was not remembered, so a config-layer value would come back',
  )
})

await check('re-adding an assignment clears its tombstone', async () => {
  await plugin.call('/bas-remote/ports', 'POST', { forwardPorts: { [OTHER]: { dropbear: 46000, bridge: 46001 } } })
  assert.ok(!persistedState().removedForwardPorts.includes(OTHER), 'the tombstone survived a new assignment')
  assert.deepEqual((await plugin.snapshot()).forwardPorts[OTHER], { dropbear: 46000, bridge: 46001 })
})

// The version that made the UI look broken: the value came from config, and a
// plain key deletion could never beat it.
const configPlugin = await (async () => {
  seedState({ landscapes: [], lastDevSpace: '', forwardPorts: {} })
  return loadPlugin({ forwardPorts: { [WS]: { dropbear: 47000, bridge: 47001 } } })
})()

await check('a config-layer assignment is visible to the UI', async () => {
  assert.deepEqual((await configPlugin.snapshot()).forwardPorts[WS], { dropbear: 47000, bridge: 47001 })
})

await check('a config-layer assignment can be deleted from the UI', async () => {
  const response = await configPlugin.call('/bas-remote/ports', 'POST', { forwardPorts: { [WS]: null } })
  assert.equal(response.status, 200)
  assert.equal(response.body.forwardPorts[WS], undefined, 'the config value still wins over the deletion')
  assert.equal((await configPlugin.snapshot()).forwardPorts[WS], undefined)
})

await check('the strict toggle reports the effective value, not just the stored one', async () => {
  const first = await configPlugin.call('/bas-remote/strict', 'POST', {})
  assert.equal(first.body.forwardPortsStrict, false, 'toggling from the default true must turn strict off')
  assert.equal((await configPlugin.snapshot()).forwardPortsStrict, false)
  const second = await configPlugin.call('/bas-remote/strict', 'POST', {})
  assert.equal(second.body.forwardPortsStrict, true)
  const explicit = await configPlugin.call('/bas-remote/strict', 'POST', { strict: false })
  assert.equal(explicit.body.forwardPortsStrict, false)
})

await check('the state snapshot is what the port settings render', async () => {
  const state = await configPlugin.snapshot()
  assert.ok(state.forwardPorts && typeof state.forwardPorts === 'object', 'no forwardPorts in the snapshot')
  assert.equal(typeof state.forwardPortsStrict, 'boolean')
})

console.log(checks.join('\n'))
console.log(process.exitCode ? '\nPort routes: FAILED' : `\nPort routes: ${checks.length} checks passed`)
