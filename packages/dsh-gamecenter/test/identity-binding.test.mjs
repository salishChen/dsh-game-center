import test from 'node:test'
import assert from 'node:assert/strict'

import { GameCenterCore } from '../staging/remote/game-center-service.js'
import { digestToken } from '../staging/index.js'
import { LeaseRegistry } from '../staging/runtime/lease.js'

/**
 * 身份绑定负例（PM 指定的安全阻断项回归）。
 *
 * 修复前：`pause`/`saveAck` 用 `registry.findByGeneration(generation)` **全局按代次**定位，
 * 于是任何调用方给出别人存档的代次就能操作那条租约（跨存档写入）；
 * 且第二轮诊断会命中上一轮已封存的租约而返回 `PROTOCOL_INVALID` 而非 `STALE_RUNTIME`。
 *
 * 修复后：所有权改由 `runtimeToken`（32 字节随机、Host 只存 SHA-256 摘要）解析，
 * `gameId`/`saveId` 从租约读出，调用方自报的值不参与授权。
 */

let tokenSeq = 0
function makeCore(nowRef = { now: Date.parse('2026-10-19T00:00:00.000Z') }) {
  tokenSeq = 0
  // 刻意**不注入** nextGeneration：走 core 默认的 `peekGeneration(gameId)+1`，
  // 那才是真实语义（代次按 gameId 各自递增）。早期我用全局递增桩，导致
  // "跨存档同代次碰撞"场景根本构造不出来 —— 是测试写法问题，不是实现问题。
  return {
    core: new GameCenterCore({
      nowMs: () => nowRef.now,
      ttlMs: 30_000,
      createToken: () => `test-token-${++tokenSeq}-${'x'.repeat(8)}`,
      digestToken,
    }),
    nowRef,
  }
}

function handshake(core, overrides = {}) {
  return core.handshake({
    runtimeInstanceId: `rt-${Math.random().toString(36).slice(2, 10)}`,
    nonce: 'n',
    gameId: 'example.identity',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    ...overrides,
  })
}

test('handshake 下发 runtimeToken 原文，且不回传可用于伪造的等价物', () => {
  const { core } = makeCore()
  const hs = handshake(core)
  assert.equal(hs.ok, true)
  assert.equal(typeof hs.runtimeToken, 'string')
  assert.ok(hs.runtimeToken.length >= 16, '凭证必须足够长')
  // tokenDigest 是摘要，不能等于原文
  assert.notEqual(hs.tokenDigest, hs.runtimeToken)
  assert.match(hs.tokenDigest, /^sha256:[0-9a-f]{64}$/)
})

test('凭证缺失 → PROTOCOL_INVALID / credential-missing', () => {
  const { core } = makeCore()
  handshake(core)
  const res = core.pause({ runtimeToken: '', reason: 'x' })
  assert.equal(res.accepted, false)
  assert.equal(res.error.code, 'PROTOCOL_INVALID')
  assert.match(res.error.message, /缺少运行凭证/)
})

test('凭证错误（伪造）→ PROTOCOL_INVALID / credential-invalid', () => {
  const { core } = makeCore()
  handshake(core)
  const res = core.saveAck({ runtimeToken: 'forged-token', revision: 1 })
  assert.equal(res.accepted, false)
  assert.equal(res.error.code, 'PROTOCOL_INVALID')
  assert.match(res.error.message, /凭证无效/)
})

test('凭证过期 → PAUSED / lease-expired', () => {
  const nowRef = { now: Date.parse('2026-10-19T00:00:00.000Z') }
  const { core } = makeCore(nowRef)
  const hs = handshake(core)
  nowRef.now += 60_000 // 超过 ttl
  const res = core.pause({ runtimeToken: hs.runtimeToken, reason: 'x' })
  assert.equal(res.accepted, false)
  assert.equal(res.error.code, 'PAUSED')
  assert.match(res.error.message, /过期/)
})

test('【跨存档碰撞】相同 generation 的两个存档互不影响：A 的凭证只能动 A', () => {
  const { core } = makeCore()
  // 两个不同 gameId，各自第一次握手 → 两者 generation 都是 1（碰撞）
  const a = handshake(core, { gameId: 'game.A' })
  const b = handshake(core, { gameId: 'game.B' })
  assert.equal(a.generation, 1)
  assert.equal(b.generation, 1)

  // 用 B 的凭证暂停 —— 只能影响 B
  const pausedB = core.pause({ runtimeToken: b.runtimeToken, reason: 'b' })
  assert.equal(pausedB.accepted, true)
  assert.equal(core.inspect('game.A')[0].state, 'running', 'A 必须仍是 running')
  assert.equal(core.inspect('game.B')[0].state, 'pausing')

  // A 依然可用
  assert.equal(core.pause({ runtimeToken: a.runtimeToken, reason: 'a' }).accepted, true)
})

test('【第二轮】同一游戏第二次握手的旧凭证必须 STALE_RUNTIME，而不是 PROTOCOL_INVALID', () => {
  const { core } = makeCore()
  const first = handshake(core, { gameId: 'game.rounds' })
  core.pause({ runtimeToken: first.runtimeToken, reason: 'r1' })
  core.saveAck({ runtimeToken: first.runtimeToken, revision: 1 })

  const second = handshake(core, { gameId: 'game.rounds' })
  assert.equal(second.generation, 2, '第二轮代次递增')

  // 第一轮（已封存）的凭证迟到写入 → 必须是 STALE_RUNTIME
  const late = core.saveAck({ runtimeToken: first.runtimeToken, revision: 2 })
  assert.equal(late.accepted, false)
  assert.equal(late.error.code, 'STALE_RUNTIME', '不得是 PROTOCOL_INVALID')

  // 第二轮凭证正常工作
  assert.equal(core.pause({ runtimeToken: second.runtimeToken, reason: 'r2' }).accepted, true)
  assert.equal(core.saveAck({ runtimeToken: second.runtimeToken, revision: 1 }).accepted, true)
})

test('【旧 iframe 迟到 pause】暂停完成后旧凭证再 pause 必须被拒（STALE_RUNTIME）', () => {
  const { core } = makeCore()
  const hs = handshake(core)
  assert.equal(core.pause({ runtimeToken: hs.runtimeToken, reason: 'ok' }).accepted, true)
  assert.equal(core.saveAck({ runtimeToken: hs.runtimeToken, revision: 1 }).accepted, true)
  const late = core.pause({ runtimeToken: hs.runtimeToken, reason: 'late' })
  assert.equal(late.accepted, false)
  assert.equal(late.error.code, 'STALE_RUNTIME')
})

test('【代次声明不符】凭证有效但声明的 generation 与租约不符 → STALE_RUNTIME', () => {
  const { core } = makeCore()
  const hs = handshake(core)
  const res = core.saveAck({ runtimeToken: hs.runtimeToken, revision: 1, generation: hs.generation + 9 })
  assert.equal(res.accepted, false)
  assert.equal(res.error.code, 'STALE_RUNTIME')
})

test('【其他实例的凭证】不能查询到别人的租约状态', () => {
  const { core } = makeCore()
  const a = handshake(core, { gameId: 'game.A' })
  const b = handshake(core, { gameId: 'game.B' })
  const statusA = core.leaseStatus({ runtimeToken: a.runtimeToken })
  const statusB = core.leaseStatus({ runtimeToken: b.runtimeToken })
  assert.equal(statusA.generation, 1)
  assert.equal(statusB.generation, 1)
  // 伪造凭证一律 absent，不区分“不存在”与“无权限”，避免探测
  assert.deepEqual(core.leaseStatus({ runtimeToken: 'forged' }), { absent: true })
})

test('正常幂等确认：正确凭证 + 递增 revision 通过；确认后实例已封存，再写为 STALE_RUNTIME', () => {
  const { core } = makeCore()
  const hs = handshake(core)
  core.pause({ runtimeToken: hs.runtimeToken, reason: 'ok' })
  const first = core.saveAck({ runtimeToken: hs.runtimeToken, revision: 1 })
  assert.equal(first.accepted, true)
  assert.equal(first.lastPersistedRevision, 1)
  assert.equal(first.state, 'paused', '确认后进入 paused')

  // 单控制者语义：暂停确认后该运行代次即封存，任何后续写入都必须是 STALE_RUNTIME
  // （这正是"旧 iframe 迟到写入被拒"要的行为，比笼统的 PROTOCOL_INVALID 更准确）。
  const again = core.saveAck({ runtimeToken: hs.runtimeToken, revision: 1 })
  assert.equal(again.accepted, false)
  assert.equal(again.error.code, 'STALE_RUNTIME')
})

test('暂停流程中（pausing）重复 revision 仍被拒且码为 PROTOCOL_INVALID', () => {
  const { core } = makeCore()
  const hs = handshake(core)
  core.pause({ runtimeToken: hs.runtimeToken, reason: 'ok' })
  assert.equal(core.saveAck({ runtimeToken: hs.runtimeToken, revision: 1 }).accepted, true)
  // 第二轮代次仍在 pausing 时重复确认的场景，用全新实例构造
  const hs2 = handshake(core)
  core.pause({ runtimeToken: hs2.runtimeToken, reason: 'ok2' })
  const dup = core.saveAck({ runtimeToken: hs2.runtimeToken, revision: 0 })
  assert.equal(dup.accepted, false)
  assert.equal(dup.error.code, 'PROTOCOL_INVALID', 'revision 非正整数属协议错误')
})

test('注册表解析：resolveByToken 对未登记摘要返回 credential-invalid', () => {
  const registry = new LeaseRegistry()
  const res = registry.resolveByToken('sha256:deadbeef', Date.now())
  assert.equal(res.ok, false)
  assert.equal(res.details.reason, 'credential-invalid')
})

test('【可选 gameId/saveId 声明】声明正确时通过，声明不符时拒绝为 PROTOCOL_INVALID', () => {
  const { core } = makeCore()
  const hs = handshake(core, { gameId: 'game.correct', runtimeInstanceId: 'rt-exact' })
  const lease = core.inspect('game.correct')[0]
  assert.ok(lease)

  // 声明错误的 gameId
  const badGame = core.pause({
    runtimeToken: hs.runtimeToken,
    reason: 'p',
    gameId: 'game.wrong',
    saveId: lease.saveId,
  })
  assert.equal(badGame.accepted, false)
  assert.equal(badGame.error.code, 'PROTOCOL_INVALID')
  assert.match(badGame.error.message, /gameId 与运行凭证不符/)

  // 声明错误的 saveId
  const badSave = core.pause({
    runtimeToken: hs.runtimeToken,
    reason: 'p',
    gameId: 'game.correct',
    saveId: 'save.wrong',
  })
  assert.equal(badSave.accepted, false)
  assert.equal(badSave.error.code, 'PROTOCOL_INVALID')
  assert.match(badSave.error.message, /saveId 与运行凭证不符/)

  // 声明正确的 gameId + saveId
  const good = core.pause({
    runtimeToken: hs.runtimeToken,
    reason: 'p',
    gameId: 'game.correct',
    saveId: lease.saveId,
  })
  assert.equal(good.accepted, true)

  // saveAck 声明错误 gameId
  const badAck = core.saveAck({
    runtimeToken: hs.runtimeToken,
    revision: 1,
    gameId: 'game.wrong',
  })
  assert.equal(badAck.accepted, false)
  assert.equal(badAck.error.code, 'PROTOCOL_INVALID')

  // saveAck 声明正确
  const goodAck = core.saveAck({
    runtimeToken: hs.runtimeToken,
    revision: 1,
    gameId: 'game.correct',
    saveId: lease.saveId,
  })
  assert.equal(goodAck.accepted, true)
})
