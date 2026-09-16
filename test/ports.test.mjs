// Tests for the host half's port-assignment routes (lib/index.js).
//
// Port assignments are machine-local runtime data: they live in
// `~/.dsh/bas-remote/state.json` and are edited from the settings page or
// `/bas ports`. There is no longer a config layer for them (0.5.0+3 removed the
// `forwardPorts` schema key), so a deletion is a plain key removal — but it
// only works because the client sends an explicit `null`: the route merges a
// payload into state, so a key that is merely absent deletes nothing and the
// row would reappear on the next poll.
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

  /** Resolve a port the way a connect would, through the captured tools. */
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

// A state file written by 0.5.0+2 also carries `removedForwardPorts`; it must be
// ignored on read and cleaned out of the file on the next write.
seedState({
  landscapes: [],
  lastDevSpace: WS,
  forwardPorts: { [WS]: { dropbear: 44000, bridge: 44001 } },
  removedForwardPorts: ['ws-stale'],
})

const plugin = await loadPlugin()

await check('a 0.5.0+2 state file still loads, tombstone list and all', async () => {
  const state = await plugin.snapshot()
  assert.deepEqual(state.forwardPorts[WS], { dropbear: 44000, bridge: 44001 })
  assert.equal(state.removedForwardPorts, undefined, 'the dropped tombstone list must not leak into the snapshot')
})

await check('an added assignment is validated, persisted and reported', async () => {
  const response = await plugin.call('/bas-remote/ports', 'POST', {
    forwardPorts: { [OTHER]: { dropbear: 45000, bridge: 45001 } },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.forwardPorts[OTHER], { dropbear: 45000, bridge: 45001 })
  assert.deepEqual((await plugin.snapshot()).forwardPorts[OTHER], { dropbear: 45000, bridge: 45001 })
})

const REJECTED = [
  ['a string port', { dropbear: '44000', bridge: 45001 }],
  ['a negative port', { dropbear: -1, bridge: 45001 }],
  ['an out-of-range port', { dropbear: 70000, bridge: 45001 }],
  ['a missing kind', { dropbear: 45000 }],
  ['an array', [45000, 45001]],
]

for (const [label, value] of REJECTED) {
  await check(`a payload with ${label} is refused`, async () => {
    const response = await plugin.call('/bas-remote/ports', 'POST', { forwardPorts: { [OTHER]: value } })
    assert.equal(response.status, 400, 'the route accepted an unusable port assignment')
    assert.match(response.body.error, /port|object/i)
    assert.deepEqual((await plugin.snapshot()).forwardPorts[OTHER], { dropbear: 45000, bridge: 45001 }, 'the rejected write still changed state')
  })
}

await check('0 is accepted and means a random port, as the settings page sends', async () => {
  const response = await plugin.call('/bas-remote/ports', 'POST', {
    forwardPorts: { [OTHER]: { dropbear: 44000, bridge: 0 } },
  })
  assert.equal(response.status, 200, 'a blank field must stay storable')
  assert.deepEqual((await plugin.snapshot()).forwardPorts[OTHER], { dropbear: 44000, bridge: 0 })
  // `resolveForwardPort` reads 0 as "ask the kernel", so pinning one end and
  // leaving the other random has to survive the round trip.
  await plugin.call('/bas-remote/ports', 'POST', { forwardPorts: { [OTHER]: { dropbear: 45000, bridge: 45001 } } })
})

await check('a bad entry does not half-apply a multi-entry batch', async () => {
  const response = await plugin.call('/bas-remote/ports', 'POST', {
    forwardPorts: { 'ws-good': { dropbear: 46000, bridge: 46001 }, 'ws-bad': { dropbear: -1, bridge: 47001 } },
  })
  assert.equal(response.status, 400)
  assert.equal((await plugin.snapshot()).forwardPorts['ws-good'], undefined, 'the valid half of a rejected batch leaked into state')
})

await check('a null removes the assignment instead of merging it back', async () => {
  const response = await plugin.call('/bas-remote/ports', 'POST', { forwardPorts: { [OTHER]: null } })
  assert.equal(response.status, 200)
  assert.equal(response.body.forwardPorts[OTHER], undefined, 'the route still reports the deleted assignment')
  assert.equal((await plugin.snapshot()).forwardPorts[OTHER], undefined, 'the deleted assignment is still displayed')
  assert.equal(persistedState().forwardPorts[OTHER], undefined, 'the deletion was not persisted')
})

await check('a deletion survives a plugin reload', async () => {
  // The whole point of the reported bug: the row must not come back.
  const reloaded = await loadPlugin()
  assert.equal((await reloaded.snapshot()).forwardPorts[OTHER], undefined, 'the assignment returned after a reload')
})

await check('re-adding an assignment works after a deletion', async () => {
  await plugin.call('/bas-remote/ports', 'POST', { forwardPorts: { [OTHER]: { dropbear: 46000, bridge: 46001 } } })
  assert.deepEqual((await plugin.snapshot()).forwardPorts[OTHER], { dropbear: 46000, bridge: 46001 })
})

await check('a state write drops the obsolete tombstone field', async () => {
  assert.equal(persistedState().removedForwardPorts, undefined, 'the tombstone list is still being written')
})

await check('strict mode comes from the config default and is overridden by state', async () => {
  seedState({ landscapes: [], lastDevSpace: '', forwardPorts: {} })
  const strictByDefault = await loadPlugin()
  assert.equal((await strictByDefault.snapshot()).forwardPortsStrict, true, 'the schema default must still supply strict mode')
  const first = await strictByDefault.call('/bas-remote/strict', 'POST', {})
  assert.equal(first.body.forwardPortsStrict, false, 'toggling from the default true must turn strict off')
  assert.equal(persistedState().forwardPortsStrict, false, 'the toggle must persist')
  const lenient = await loadPlugin({ forwardPortsStrict: false })
  assert.equal((await lenient.snapshot()).forwardPortsStrict, false)
  const explicit = await lenient.call('/bas-remote/strict', 'POST', { strict: true })
  assert.equal(explicit.body.forwardPortsStrict, true)
})

// The removed config key must fail loudly: schemastery passes unknown keys
// through, so silence here would mean pinned ports quietly going random.
await check('a leftover forwardPorts config key is rejected with a clear error', async () => {
  seedState({ landscapes: [], lastDevSpace: '', forwardPorts: {} })
  await assert.rejects(
    () => loadPlugin({ forwardPorts: { [WS]: { dropbear: 44000, bridge: 44001 } } }),
    (error) => {
      assert.match(error.message, /forwardPorts is no longer a plugin config key/)
      assert.match(error.message, /state\.json/, 'the error should say where assignments live now')
      return true
    },
  )
})

await check('an empty forwardPorts config key is tolerated', async () => {
  const empty = await loadPlugin({ forwardPorts: {} })
  assert.equal((await empty.snapshot()).forwardPorts[WS], undefined)
})

await check('the state snapshot is what the port settings render', async () => {
  const state = await plugin.snapshot()
  assert.ok(state.forwardPorts && typeof state.forwardPorts === 'object', 'no forwardPorts in the snapshot')
  assert.equal(typeof state.forwardPortsStrict, 'boolean')
  assert.deepEqual(state.forwardPorts[WS], { dropbear: 44000, bridge: 44001 })
})

console.log(checks.join('\n'))
console.log(process.exitCode ? '\nPort routes: FAILED' : `\nPort routes: ${checks.length} checks passed`)
