/**
 * 鐪熷疄瑁呴厤澶嶇幇锛歚/api/gameCenter/*` 涓轰粈涔?404锛屼互鍙婁慨娉曡兘鍚﹁绔偣琚棰嗐€? *
 * 瀹炴満鐜拌薄锛欳lient `$mount` 姝ｅ父锛堣兘璇诲埌 remote.gameCenter锛夛紝浣? *   /api/gameCenter/handshake    鈫?HTTP 404
 *   /api/gameCenter/modelCatalog 鈫?HTTP 404
 *
 * Client 鐨?$mount 鍙敞鍐?Client 渚?contribution锛屼笌 Host 鏄惁娉ㄥ唽鏈嶅姟鏃犲叧銆? * Gateway 鐢?`collectSrcClaims()` 鍐冲畾璁ら鍝簺绔偣锛堟湭璁ら鍗?404锛夛細
 *   閬嶅巻 ctx.reflect.props 閲?type==='service' 鐨勯」 鈫?璇?typertRemote.namespace锛坰tring锛? *   鈫?瀵?remoteMethods(original) 閲屾瘡涓柟娉曞０鏄?`<namespace>/<method>`銆? *
 * 鏈帰閽堣窇涓夌粍锛屽叏閮ㄤ娇鐢?asar 閲岄噴鏀剧殑**鐪熷疄** cordis 涓?dsh-typert-protocol锛? *   A 褰撳墠 Host 浜х墿 + 榛樿 dynamicProtocolLoader锛堥粯璁よ矾寰勶級
 *   B 褰撳墠 Host 浜х墿 + 鏄惧紡浼犲叆鐪熷疄 protocol 妯″潡锛堝彧淇涓€涓己闄凤級
 *   C 鐢ㄧ湡瀹?tsc 鏍囧噯瑁呴グ鍣ㄧ紪璇戠殑鏈嶅姟绫伙紙瀹屾暣淇硶锛? *
 * 鍓嶇疆锛歟xtract-cordis.mjs銆乪xtract-typert.mjs
 * 杩愯锛歯ode tools/cordis-inject-probe/repro-remote-claims.mjs
 * 閫€鍑虹爜锛? = 缁撹涓庨鏈熶竴鑷? */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(os.tmpdir(), 'cordis-real')
const NM = path.join(ROOT, 'node_modules')
const CORDIS = path.join(NM, '@deepseek-ai', 'cordis', 'lib', 'index.js')
const PROTOCOL = path.join(NM, '@deepseek-ai', 'dsh-typert-protocol', 'lib', 'index.js')
const HOST_MODULE = path.resolve('packages/dsh-gamecenter/lib/index.js')
const TSC_JS = path.resolve('node_modules/typescript/lib/tsc.js')

for (const [label, p] of [
  ['cordis', CORDIS],
  ['dsh-typert-protocol', PROTOCOL],
  ['Host 浜х墿', HOST_MODULE],
  ['tsc', TSC_JS],
]) {
  if (!fs.existsSync(p)) {
    console.error(`缂哄皯${label}锛?{p}\n鍏堣繍琛?extract-cordis.mjs 涓?extract-typert.mjs`)
    process.exit(2)
  }
}

const { Context, Service } = await import(pathToFileURL(CORDIS).href)
const protocol = await import(pathToFileURL(PROTOCOL).href)
const host = await import(pathToFileURL(HOST_MODULE).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WANT = ['gameCenter/handshake', 'gameCenter/modelCatalog']

class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
  }
}

/** 閫愬瓧瀵圭収 dsh-api-gateway 鐨?collectSrcClaims()銆?*/
function collectSrcClaims(ctx) {
  const claims = new Set()
  for (const [serviceKey, definition] of Object.entries(ctx.reflect.props)) {
    if (definition.type !== 'service') continue
    const receiver = ctx.get(serviceKey)
    if (receiver === null || receiver === undefined) continue
    const binding = Reflect.get(receiver, 'typertRemote')
    if (binding === null || typeof binding !== 'object') continue
    const namespace = Reflect.get(binding, 'namespace')
    if (typeof namespace !== 'string') continue
    for (const candidate of protocol.remoteMethods(receiver)) {
      claims.add(`${namespace}/${candidate.exportName ?? candidate.method}`)
    }
  }
  return [...claims].sort()
}

async function runHost(label, options) {
  const root = new Context()
  root.plugin(FakeLlm)
  let out
  let failure = null
  const fiber = root.plugin({
    name: `gamecenter-${label}`,
    inject: host.inject,
    apply: (ctx) => {
      try {
        out = host.apply(ctx, options)
      } catch (error) {
        failure = error.message
        throw error
      }
    },
  })
  await fiber
  await sleep(40)
  return {
    label,
    remoteMounted: out?.remoteMounted ?? null,
    failure: failure ?? fiber._error?.message ?? null,
    claims: collectSrcClaims(root),
  }
}

// ---------- C锛氱湡瀹?tsc 鏍囧噯瑁呴グ鍣?----------
const decoratedTs = path.join(ROOT, 'decorated-probe.ts')
fs.writeFileSync(
  decoratedTs,
  `// @ts-nocheck
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class DecoratedGameCenter extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'gameCenter', { namespace: 'gameCenter' })
  }
  @Remote
  handshake(input) { return { ok: true } }
  @Remote
  saveAck(input) { return { accepted: true } }
  @Remote
  pause(input) { return { accepted: true } }
  @Remote
  leaseStatus(input) { return { absent: true } }
  @Remote
  async modelCatalog(signal) { return { available: false } }
}
`,
)

execFileSync(process.execPath, [TSC_JS, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'decorated-probe.ts'], {
  cwd: ROOT,
  stdio: 'pipe',
})
const { DecoratedGameCenter } = await import(pathToFileURL(path.join(ROOT, 'decorated-probe.js')).href)

async function runDecorated() {
  const root = new Context()
  let instance
  const fiber = root.plugin({
    name: 'gamecenter-decorated',
    apply: (ctx) => {
      instance = new DecoratedGameCenter(ctx)
    },
  })
  await fiber
  await sleep(40)
  return {
    label: 'C-decorated',
    failure: fiber._error?.message ?? null,
    markers: instance ? protocol.remoteMethods(instance).map((m) => m.exportName ?? m.method) : null,
    claims: collectSrcClaims(root),
  }
}

const a = await runHost('A-default-loader', {})
const b = await runHost('B-real-protocol', { protocol: { load: () => protocol } })
const c = await runDecorated()

console.log('=== 鐪熷疄瑁呴厤锛欸ateway 绔偣璁ら澶嶇幇 ===')
for (const r of [a, b, c]) console.log(JSON.stringify(r))

const passA = a.claims.length === 0 && WANT.every((e) => !a.claims.includes(e))
const passC = c.failure === null && WANT.every((e) => c.claims.includes(e))

console.log('---')
console.log('A 褰撳墠榛樿璺緞锛氭棤 gameCenter 绔偣璁ら锛?404 鏍瑰洜锛?鈫?' + (passA ? 'PASS' : 'FAIL'))
console.log(`B 鍙紶鐪熷疄 protocol锛?{b.failure ? '澶辫触 ' + b.failure : '鏈敞鍐屾湇鍔?} 鈫?璇存槑杩橀渶淇楗板櫒璋冪敤`)
console.log('C 鏍囧噯瑁呴グ鍣ㄦ湇鍔★細gameCenter 绔偣琚棰嗭紙=淇硶鍙锛?鈫?' + (passC ? 'PASS' : 'FAIL'))
console.log('C 璁ら绔偣: ' + c.claims.join(', '))

process.exit(passA && passC ? 0 : 1)

