#!/usr/bin/env node
/**
 * 12 方法一致性 + 生产接线守卫对账（架构与协议负责人维护）。
 *
 * 这不是 `pnpm test` 的一部分：它故意在"契约已冻结、实现还没跟上"时**失败**，
 * 用来把缺口指到具体文件与行，而不是让 316 项单测继续显示全绿。
 *
 * 用法：
 *   node tools/audit-wire-consistency.mjs
 *   node tools/audit-wire-consistency.mjs --json
 *
 * 判据（任一不满足即退出码 1）：
 *   1. Host `@Remote` 方法集 == Client contribution 方法集 == protocol `GAMECENTER_REMOTE_METHODS`
 *   2. Host 生产入口不得把 `MemorySaveBackend` 当缺省后端
 *   3. Client 不得硬编码 `playerId`，不得用伪造 revision 顶替真实写入
 *   4. Client 必须接 `saveCheckpoint` / `saveAck` / `previewBundle`（有 Remote 却没人调用 = 断线）
 *   5. Client iframe 的 sandbox 必须是 `allow-scripts`（来自 protocol 常量，不得内联放宽）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

/** @param {string} relative @returns {string} */
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

/** @type {{name: string, passed: boolean, detail: string[]}[]} */
const checks = []

/** @param {string} name @param {boolean} passed @param {string[]} detail */
function report(name, passed, detail = []) {
  checks.push({ name, passed, detail })
}

// --- 1. 三方方法集 ---
const protocolModule = await import(pathToFileURL(path.join(ROOT, 'packages/protocol/dist/index.js')).href)
const protocolMethods = [...protocolModule.GAMECENTER_REMOTE_METHODS]

const clientModule = await import(
  pathToFileURL(path.join(ROOT, 'packages/dsh-gamecenter-client/src/bridge/remote-mount.js')).href
)
const clientMethods = clientModule.createGameCenterContribution().descriptors.map((descriptor) => descriptor.method)

const hostSource = read('packages/dsh-gamecenter/src/remote/game-center-service.ts')
const hostMethods = [...hostSource.matchAll(/@Remote\s*\n\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g)].map(
  (match) => match[1],
)

/**
 * @param {string[]} left @param {string[]} right
 * @returns {{missing: string[], extra: string[]}}
 */
function diff(left, right) {
  return {
    missing: left.filter((name) => !right.includes(name)),
    extra: right.filter((name) => !left.includes(name)),
  }
}

const hostDiff = diff(protocolMethods, hostMethods)
const clientDiff = diff(protocolMethods, clientMethods)

report(
  '1a Host @Remote 覆盖 protocol 方法表',
  hostDiff.missing.length === 0 && hostDiff.extra.length === 0,
  [
    `protocol=${protocolMethods.length} host=${hostMethods.length}`,
    ...hostDiff.missing.map((name) => `Host 缺 ${name}`),
    ...hostDiff.extra.map((name) => `Host 多出未冻结方法 ${name}`),
  ],
)

report(
  '1b Client contribution 覆盖 protocol 方法表',
  clientDiff.missing.length === 0 && clientDiff.extra.length === 0,
  [
    `client=${clientMethods.length}`,
    ...clientDiff.missing.map((name) => `Client 缺 ${name}`),
    ...clientDiff.extra.map((name) => `Client 多出未冻结方法 ${name}`),
  ],
)

// --- 2. Host 缺省后端不得是内存 ---
const hostEntry = read('packages/dsh-gamecenter/src/index.ts')
const memoryDefault = /storageBackend\s*\?\?\s*new\s+MemorySaveBackend\(\)/.test(hostEntry)
report('2 Host 生产入口默认使用 SQLite 而非内存', !memoryDefault, [
  memoryDefault
    ? 'src/index.ts 仍是 `options.storageBackend ?? new MemorySaveBackend()`：真实 DSH 重启存档即丢'
    : '未发现内存缺省',
])

// --- 3/4. Client 不得伪造身份与 revision，必须真的调 Remote ---
const overlay = read('packages/dsh-gamecenter-client/src/ui/GameCenterOverlay.js')
const hardcodedPlayer = /playerId\s*:\s*['"][^'"]+['"]/.test(overlay)
report('3a Client 不硬编码 playerId', !hardcodedPlayer, [
  hardcodedPlayer ? "GameCenterOverlay.js 出现硬编码 playerId（身份只能由 Host 绑定）" : '未发现硬编码身份',
])

const fakeCheckpoint = /onCheckpoint:\s*async\s*\([^)]*\)\s*=>\s*\{\s*return\s*\{[^}]*revision\s*:\s*\(?\s*input\.expectedRevision/.test(
  overlay,
)
report('3b Client 不用伪造 revision 顶替真实写入', !fakeCheckpoint, [
  fakeCheckpoint ? 'onCheckpoint 直接返回 expectedRevision+1，没有写入任何存储（假保存）' : '未发现伪造 revision',
])

for (const method of ['saveCheckpoint', 'saveAck', 'previewBundle']) {
  const used = new RegExp(`\\b${method}\\b`).test(overlay)
  report(`4 Client 实际调用 ${method}`, used, [
    used ? '已接线' : `GameCenterOverlay.js 没有调用 ${method}：有 Remote 但没人用，等于没接`,
  ])
}

// --- 5. sandbox 常量 ---
const assemblerSandbox = (() => {
  try {
    return /GAME_IFRAME_SANDBOX\s*=\s*'([^']+)'/.exec(read('packages/dsh-gamecenter-client/src/runtime/assembler.js'))?.[1]
  } catch {
    return undefined
  }
})()
report('5 Client sandbox 恒为 allow-scripts', assemblerSandbox === 'allow-scripts', [
  `assembler.js GAME_IFRAME_SANDBOX=${JSON.stringify(assemblerSandbox)}`,
])

// --- 6. 生命周期：取消 + 有界未确认回收（2026-10-20，PM 冻结契约） ---
// 孤儿 running 的根因是 `acquire()` 对已封存槽位无条件放行，而握手不携带调用方存活证据。
// 这里只做**静态守卫**：两侧是否真的接上由 probe-host-entry.mjs 的 N9..N12 动态证明。

const hostServiceSource = readFileSync(path.join(ROOT, 'packages/dsh-gamecenter/src/remote/game-center-service.ts'), 'utf8')
const leaseSource = readFileSync(path.join(ROOT, 'packages/dsh-gamecenter/src/runtime/lease.ts'), 'utf8')

const hasAbandon = /@Remote\s*\n\s*(?:async\s+)?abandonRuntime\s*\(/.test(hostServiceSource)
report('6a Host 声明 @Remote abandonRuntime', hasAbandon, [
  hasAbandon ? '已声明' : 'Host 缺少 abandonRuntime：迟到握手无法被快路径取消',
])

const abandonsByToken = /launchToken/.test(hostServiceSource) && /launchToken/.test(leaseSource)
report('6b 取消必须绑定 launchToken（不得仅凭 gameId/saveId 撤销）', abandonsByToken, [
  abandonsByToken ? 'launchToken 已进入 Host 服务与租约层' : 'Host 未使用 launchToken：任意调用方都能撤销别人的实例',
])

const hasAckWindow = /ACK_WINDOW|ackDeadline|unconfirmed/i.test(leaseSource) || /ACK_WINDOW|ackDeadline/i.test(hostServiceSource)
report('6c 未确认握手有有界回收（T_ack）', hasAckWindow, [
  hasAckWindow ? '存在未确认窗口判定' : '缺少 T_ack：客户端崩溃后 pending/running 租约永不回收',
])

const idleBasedReclaim = /lastActivityMs|lastActiveAt|idleSince/.test(leaseSource)
report('6d 不得以"玩家静止"作为回收依据', !idleBasedReclaim, [
  idleBasedReclaim ? '租约层出现最后活动时间驱动的回收：会误杀正常静置的玩家' : '未发现活动时间驱动回收',
])

const clientSource = (() => {
  try {
    return read('packages/dsh-gamecenter-client/src/ui/GameCenterOverlay.js')
  } catch {
    return ''
  }
})()
const clientAbandons = /\babandonRuntime\b/.test(clientSource) && /launchToken/.test(clientSource)
report('6e Client 在 abort/关闭时调用 abandonRuntime', clientAbandons, [
  clientAbandons ? '已接线' : 'Client 未接线：快路径取消缺失，只能等 T_ack 兜底',
])

// --- 输出 ---
const failed = checks.filter((check) => !check.passed)
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
} else {
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`)
    for (const line of check.detail) console.log(`        ${line}`)
  }
  console.log('')
  console.log(`合计 ${checks.length} 项，失败 ${failed.length} 项`)
  if (failed.length > 0) {
    console.log('结论：生产接线未就绪（上列 FAIL 即缺口；单测全绿不代表接通）')
  }
}

process.exit(failed.length === 0 ? 0 : 1)
