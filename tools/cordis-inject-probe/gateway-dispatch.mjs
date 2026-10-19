/**
 * Real Gateway dispatch verification (not a copied claim algorithm).
 *
 * Loads the REAL `@deepseek-ai/dsh-api-gateway` (Host face) with REAL Cordis,
 * mounts the Host `staging/` entry through its DEFAULT apply (no fakeProtocol,
 * no test options), then:
 *   1. calls the gateway's own `claimsEndpoint()` for each endpoint;
 *   2. calls the gateway's own `invoke()` to really dispatch
 *      `gameCenter/handshake` and `gameCenter/modelCatalog`;
 *   3. records BOTH protocol copies (workspace vs asar) with absolute path + version.
 *
 * Boundaries: no listening port, no substitute server, no GUI reload, no model call
 * (llm is a zero-stream catalog stub). `typert` / `remoteAccess` are minimal stubs
 * because the gateway refuses to construct without them; `typert.local.get` returns
 * undefined and `hasSeen` false, which forces the SRC claim path this project relies on.
 *
 * Run: node tools/cordis-inject-probe/gateway-dispatch.mjs
 * Exit: 0 = all checks pass
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ASAR = 'D:\\Program Files\\deepseek harness\\resources\\app.asar'
const ARENA = path.join(os.tmpdir(), 'gateway-arena')
const NM = path.join(ARENA, 'node_modules')
const HOST_STAGING = path.resolve('packages/dsh-gamecenter/staging/index.js')

function openAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const raw = Buffer.alloc(headerSize)
  fs.readSync(fd, raw, 0, headerSize, 16)
  const root = JSON.parse(raw.toString('utf8').replace(/\0+$/, ''))
  const readEntry = (e) => {
    const buf = Buffer.alloc(e.size)
    fs.readSync(fd, buf, 0, e.size, 16 + headerSize + Number(e.offset))
    return buf.toString('utf8')
  }
  return { fd, root, readEntry }
}

const walk = (entry, prefix) => {
  const out = []
  if (!entry.files) return out
  for (const [name, child] of Object.entries(entry.files)) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) out.push(...walk(child, p))
    else out.push([p, child])
  }
  return out
}

const { fd, root, readEntry } = openAsar(ASAR)
const DSH_NM = root.files.dsh.files.node_modules.files
const SCOPE = DSH_NM['@deepseek-ai'].files

fs.rmSync(ARENA, { recursive: true, force: true })
fs.mkdirSync(NM, { recursive: true })

function emitEntry(entry, dest) {
  const files = walk(entry, '')
  for (const [rel, child] of files) {
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, readEntry(child))
  }
  return files.length
}

const wanted = [
  ['@deepseek-ai/cordis', SCOPE.cordis],
  ['@deepseek-ai/cosmokit', SCOPE.cosmokit],
  ['@deepseek-ai/dsh-brand', SCOPE['dsh-brand']],
  ['@deepseek-ai/dsh-typert-protocol', SCOPE['dsh-typert-protocol']],
  ['@deepseek-ai/dsh-api-gateway', SCOPE['dsh-api-gateway']],
  ['@deepseek-ai/dsh-deque', SCOPE['dsh-deque']],
  ['@deepseek-ai/dsh-timeout', SCOPE['dsh-timeout']],
  ['@deepseek-ai/schemastery', SCOPE.schemastery],
]
for (const [name, entry] of wanted) {
  if (!entry) {
    console.error('missing in asar: ' + name)
    process.exit(2)
  }
  emitEntry(entry, path.join(NM, ...name.split('/')))
}

const stdSpec = DSH_NM['@standard-schema'] && DSH_NM['@standard-schema'].files ? DSH_NM['@standard-schema'].files.spec : undefined
if (stdSpec) emitEntry(stdSpec, path.join(NM, '@standard-schema', 'spec'))
if (DSH_NM.zod) emitEntry(DSH_NM.zod, path.join(NM, 'zod'))
if (DSH_NM.ws) emitEntry(DSH_NM.ws, path.join(NM, 'ws'))

fs.writeFileSync(path.join(ARENA, 'package.json'), JSON.stringify({ name: 'gateway-arena', type: 'module', private: true }, null, 2))

const hostProtocolEntry = path.join(NM, '@deepseek-ai', 'dsh-typert-protocol')
const hostProtocolPkg = JSON.parse(fs.readFileSync(path.join(hostProtocolEntry, 'package.json'), 'utf8'))
const repoProtocolEntry = path.resolve('node_modules/@deepseek-ai/dsh-typert-protocol')
const repoProtocolPkg = JSON.parse(fs.readFileSync(path.join(repoProtocolEntry, 'package.json'), 'utf8'))

const { Context, Service } = await import(pathToFileURL(path.join(NM, '@deepseek-ai/cordis/lib/index.js')).href)
const gatewayMod = await import(pathToFileURL(path.join(NM, '@deepseek-ai/dsh-api-gateway/lib/index.js')).href)
const hostProtocol = await import(pathToFileURL(path.join(hostProtocolEntry, 'lib/index.js')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class FakeTypert extends Service {
  constructor(ctx) {
    super(ctx, 'typert')
    this.local = { get: () => undefined, hasSeen: () => false }
    this.lookups = { definitions: () => [] }
    this.contexts = { getHost: () => undefined, getClient: () => undefined }
    this.resources = { definitions: () => [] }
  }
}
class FakeRemoteAccess extends Service {
  constructor(ctx) {
    super(ctx, 'remoteAccess')
  }
  decide() {
    return { kind: 'allow' }
  }
}
class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
  }
  listProviders() {
    return []
  }
  listModels() {
    return []
  }
  resolveModelInfo() {
    return undefined
  }
  stream() {
    throw new Error('zero-stream: model calls are not allowed in this verification')
  }
}

const errors = []
const ctx = new Context()
ctx.plugin(FakeTypert)
ctx.plugin(FakeRemoteAccess)
ctx.plugin(FakeLlm)

let gateway
const gwFiber = ctx.plugin({
  name: 'typert-gateway-probe',
  inject: gatewayMod.TypertGatewayService.inject,
  apply: (c) => {
    gateway = new gatewayMod.TypertGatewayService(c, {})
  },
})
await gwFiber
if (gwFiber._error) errors.push('gateway: ' + gwFiber._error.message)
await sleep(40)

const hostMod = await import(pathToFileURL(HOST_STAGING).href)
let hostApi
let hostError = null
const hostFiber = ctx.plugin({
  name: 'gamecenter-host-staging',
  inject: hostMod.inject,
  apply: (c) => {
    hostApi = hostMod.apply(c)
  },
})
await hostFiber
if (hostFiber._error) hostError = hostFiber._error.message
await sleep(80)

const CALLS = [
  [
    'gameCenter/handshake',
    { input: { runtimeInstanceId: 'rt-1', nonce: 'n-1', gameId: 'probe.game', gameVersion: '1.0.0', sdkVersion: '1.0.0', bridgeVersion: 1 } },
  ],
  ['gameCenter/modelCatalog', {}],
]

const claims = []
if (gateway) {
  for (const [endpoint] of CALLS) {
    try {
      claims.push({ endpoint, claimed: gateway.claimsEndpoint(endpoint) })
    } catch (error) {
      claims.push({ endpoint, claimed: false, error: error.message })
    }
  }
}

const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
const dispatches = []
if (gateway && hostApi && hostApi.remoteMounted) {
  for (const [endpoint, args] of CALLS) {
    const parts = endpoint.split('/')
    try {
      const result = await gateway.invoke({ namespace: parts[0], method: parts[1], args, peer })
      dispatches.push({ endpoint, ok: true, result })
    } catch (error) {
      dispatches.push({
        endpoint,
        ok: false,
        code: error && error.code ? error.code : error && error.name,
        message: error && error.message,
      })
    }
  }
}

// ---------- what the real /api handler returns (the wire envelope) ----------
// dispatchRpc is the function registered as the /api interceptor. It wraps every
// result as { ok: true, value: <business result> }; the Client must unwrap .value.
const wireEnvelopes = []
if (gateway && hostApi && hostApi.remoteMounted) {
  for (const [endpoint, args] of CALLS) {
    try {
      const envelope = await gateway.dispatchRpc(endpoint, { args }, peer.signal, peer)
      wireEnvelopes.push({
        endpoint,
        envelopeKeys: Object.keys(envelope),
        ok: envelope.ok,
        hasValueKey: Object.hasOwn(envelope, 'value'),
        valueKeys: envelope.value && typeof envelope.value === 'object' ? Object.keys(envelope.value) : null,
        topLevelGeneration: envelope.generation,
        valueGeneration: envelope.value ? envelope.value.generation : undefined,
      })
    } catch (error) {
      wireEnvelopes.push({ endpoint, error: error && error.message })
    }
  }
}

const sameInstance = path.resolve(hostProtocolEntry) === path.resolve(repoProtocolEntry)
const report = {
  protocolCopies: {
    hostAsar: { path: path.join(hostProtocolEntry, 'lib', 'index.js'), version: hostProtocolPkg.version },
    repoWorkspace: { path: path.join(repoProtocolEntry, 'lib', 'index.js'), version: repoProtocolPkg.version },
    sameInstance,
  },
  hostStaging: { path: HOST_STAGING, remoteMounted: hostApi ? hostApi.remoteMounted : null, error: hostError },
  hostProtocolExportCount: Object.keys(hostProtocol).length,
  claims,
  dispatches,
  wireEnvelopes,
  dependencyStubs: [
    'typert: local.get=undefined / hasSeen=false -> forces SRC claim path',
    'remoteAccess: decide=allow',
    'llm: zero-stream catalog stub',
  ],
  setupErrors: errors,
}

console.log(JSON.stringify(report, null, 2))

const mounted = Boolean(hostApi && hostApi.remoteMounted === true)
const allClaimed = claims.length === CALLS.length && claims.every((c) => c.claimed === true)
const allDispatched = dispatches.length === CALLS.length && dispatches.every((d) => d.ok === true)

console.log('---')
console.log('Host default apply registers service : ' + (mounted ? 'PASS' : 'FAIL'))
console.log('Real claimsEndpoint claims endpoints : ' + (allClaimed ? 'PASS' : 'FAIL'))
console.log('Real invoke dispatches to methods    : ' + (allDispatched ? 'PASS' : 'FAIL'))
console.log('Two independent protocol copies      : ' + (sameInstance ? 'FAIL(same copy)' : 'PASS(cross-copy)'))

fs.closeSync(fd)
process.exit(mounted && allClaimed && allDispatched ? 0 : 1)
