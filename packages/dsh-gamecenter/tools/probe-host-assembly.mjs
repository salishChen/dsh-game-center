/**
 * 阶段0 Host 装配探针（只读）。
 *
 * 目标不是"跑通业务"，而是**如实回答**这几个问题：
 * 1. DSH 运行时是否对外提供 `@deepseek-ai/dsh-typert-protocol`？
 * 2. 本包的 `apply()` 在真实协议模块下能否装配出 `gameCenter` 命名空间的服务？
 * 3. 服务的 5 个方法是否都能被 `remoteMethods()` 读到（Gateway 的 SRC 发现前提）？
 * 4. 装不上的时候，失败原因是什么（不掩盖）。
 *
 * 用法：node tools/probe-host-assembly.mjs
 * 不修改 DSH 安装目录，不启动任何服务器，不发起模型调用。
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RESULTS = []
function record(name, status, detail) {
  RESULTS.push({ name, status, detail })
  process.stdout.write(`[${status}] ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

// ---- 1. 定位 DSH 运行时下的协议包 ----
const ASAR = 'D:/Program Files/deepseek harness/resources/app.asar'
const candidates = [
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/cordis',
]

const protocolPath = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-typert-protocol`
const protocolEntry = resolve(protocolPath, 'lib/index.js')
record('协议包在安装包内', 'STATIC', protocolEntry)

let protocol = null
try {
  // 直接用 file URL 加载 asar 内路径：Node 不认 asar 虚拟文件系统，
  // 因此这里预期失败——失败本身就是证据（必须由 DSH 进程解析，不能旁挂）。
  protocol = await import(pathToFileURL(protocolEntry).href)
  record('直读 asar 内协议包', 'OK', '意外成功：该路径可被 Node 直接 import')
} catch (error) {
  record(
    '直读 asar 内协议包',
    'EXPECTED-FAIL',
    error instanceof Error ? `${error.code ?? error.name}: ${error.message.split('\n')[0]}` : String(error),
  )
}

// ---- 2. 用真实 DSH 协议包的**接口形状**做结构化校验 ----
const probe = await import('../src/dsh-adapter/protocol.ts')
const protocolProbe = await probe.probeProtocol()
if (protocolProbe.ok) {
  record('probeProtocol()', 'OK', '当前进程可解析 DSH 协议包')
} else {
  record('probeProtocol()', 'NOT-AVAILABLE', protocolProbe.error)
}

// ---- 3. 用假协议模块验证 apply() 的装配路径形状 ----
const { apply } = await import('../src/index.ts')

function fakeProtocolModule() {
  const marked = new Map()
  function Remote() {
    return (_value, ctx) => {
      marked.set(ctx.name, {})
      return undefined
    }
  }
  class TypertRemoteService {
    constructor(ctx, serviceKey, options = {}) {
      this.ctx = ctx
      this.name = serviceKey
      this.typertRemote = Object.freeze({ service: this, serviceKey, namespace: options.namespace ?? serviceKey })
    }
  }
  return { Remote, TypertRemoteService, remoteMethods: () => [], _marked: marked }
}

const effects = []
const ctx = { effect(fn, label) { effects.push(label); fn(); return () => {} } }
const api = apply(ctx, { protocol: { load: () => fakeProtocolModule() } })
record('apply() 装配 Remote 服务', api.remoteMounted ? 'OK' : 'FAIL', `remoteMounted=${api.remoteMounted}`)
record('apply() 注册生命周期 effect', effects.length === 1 ? 'OK' : 'FAIL', effects.join(','))

// ---- 4. 无协议模块时的诚实降级 ----
const apiNoProtocol = apply(ctx, { protocol: { load: () => null } })
record(
  '协议包缺失时降级',
  apiNoProtocol.remoteMounted === false ? 'OK' : 'FAIL',
  `remoteMounted=${apiNoProtocol.remoteMounted}（应为 false，不假装装配成功）`,
)

// ---- 5. 业务路径可在无 DSH 情况下被验证 ----
const hs = api.core.handshake({
  runtimeInstanceId: 'rt-probe-1',
  nonce: 'nonce-probe',
  gameId: 'example.probe',
  gameVersion: '0.0.0',
  sdkVersion: '1.0.0',
  bridgeVersion: 1,
})
record('handshake 下发 generation', hs.ok ? 'OK' : 'FAIL', `generation=${hs.generation} tokenDigest=${hs.tokenDigest}`)
record(
  'handshake 不泄露 token 原文',
  JSON.stringify(hs).includes('rt-') === false ? 'OK' : 'CHECK',
  '回应里只应出现摘要',
)

const paused = api.core.pause({ generation: hs.generation, reason: 'probe' })
record('pause 进入 pausing', paused.accepted && paused.state === 'pausing' ? 'OK' : 'FAIL', `state=${paused.state}`)

const staleAck = api.core.saveAck({ generation: hs.generation - 1, revision: 1 })
record(
  '旧代次 saveAck 被拒',
  staleAck.accepted === false && staleAck.error.code === 'STALE_RUNTIME' ? 'OK' : 'FAIL',
  `error=${staleAck.error?.code}`,
)

const okAck = api.core.saveAck({ generation: hs.generation, revision: 1 })
record('当前代次 saveAck 接受', okAck.accepted === true ? 'OK' : 'FAIL', `state=${okAck.state}`)

const catalog = await api.core.modelCatalog(undefined)
record(
  '模型目录在无 ctx.llm 时如实报告不可用',
  catalog.available === false ? 'OK' : 'FAIL',
  `available=${catalog.available}`,
)

// ---- 汇总 ----
const summary = RESULTS.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1
  return acc
}, {})
process.stdout.write(`\n=== 汇总 ${JSON.stringify(summary)} ===\n`)
process.stdout.write(
  '说明：全部 OK/NOT-AVAILABLE 只证明「本包逻辑与装配形状正确」，\n' +
  '不证明 DSH 进程内已装配 Remote；后者需要真实 Host 装载（阶段0 DSH-REAL，未完成）。\n',
)

void createRequire
void dirname
void candidates
