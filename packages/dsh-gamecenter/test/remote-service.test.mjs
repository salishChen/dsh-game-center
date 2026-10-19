import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  GameCenterCore,
  defineGameCenterService,
  GameCenterService,
} from '../staging/remote/game-center-service.js'

const T0 = Date.parse('2026-10-18T00:00:00.000Z')

function makeCore(overrides = {}) {
  let generation = 0
  return new GameCenterCore({
    nowMs: () => T0,
    ttlMs: 30_000,
    createToken: () => 'tok-1',
    digestToken: (t) => `sha256:${t}`,
    nextGeneration: () => { generation += 1; return generation },
    ...overrides,
  })
}

test('ctx 缺失 effect 时显式抛出 TypeError，严禁静默空转', () => {
  const core = makeCore()
  assert.throws(() => defineGameCenterService(core, {}), TypeError)
  assert.throws(() => defineGameCenterService(core, { effect: 'not-a-function' }), TypeError)
})

test('装配后服务绑定 gameCenter 命名空间', () => {
  const root = new Context()
  const core = makeCore()
  const service = defineGameCenterService(core, root)
  assert.ok(service)
  assert.equal(service.name, 'gameCenter')
  assert.equal(service.typertRemote.namespace, 'gameCenter')
  assert.equal(service.typertRemote.serviceKey, 'gameCenter')
})

test('全部 5 个方法都被真实 @Remote 装饰器标记（否则 Gateway 不会暴露）', () => {
  const root = new Context()
  const core = makeCore()
  const service = defineGameCenterService(core, root)
  assert.ok(service)
  const methods = remoteMethods(service).map((m) => m.exportName ?? m.method).sort()
  assert.deepEqual(methods, ['handshake', 'leaseStatus', 'modelCatalog', 'pause', 'saveAck'])
})

test('handshake 下发 generation 与 runtimeToken，并生成运行凭证摘要', () => {
  const root = new Context()
  const core = makeCore()
  const service = defineGameCenterService(core, root)

  const first = service.handshake({
    runtimeInstanceId: 'rt-1', nonce: 'n1', gameId: 'example.game',
    gameVersion: '1.0.0', sdkVersion: '1.0.0', bridgeVersion: 1,
  })
  assert.equal(first.ok, true)
  assert.equal(first.generation, 1)
  assert.equal(first.runtimeToken, 'tok-1')
  assert.equal(first.tokenDigest, 'sha256:tok-1')
})

test('bridgeVersion 不是 1 时拒绝握手', () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)
  const result = service.handshake({
    runtimeInstanceId: 'rt-1', nonce: 'n', gameId: 'g',
    gameVersion: '1', sdkVersion: '1', bridgeVersion: 2,
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'PROTOCOL_INVALID')
})

test('saveAck 形状：凭证 + revision → 当前代次接受，旧代次或无效凭证拒绝', () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)

  const hs = service.handshake({
    runtimeInstanceId: 'rt-1', nonce: 'n', gameId: 'g',
    gameVersion: '1', sdkVersion: '1', bridgeVersion: 1,
  })
  assert.equal(hs.ok, true)

  const paused = service.pause({ runtimeToken: hs.runtimeToken, reason: 'overlay-closed' })
  assert.equal(paused.accepted, true)
  assert.equal(paused.state, 'pausing')
  assert.equal(paused.timeoutMs, 3000)

  const stale = service.saveAck({ runtimeToken: 'invalid-token', revision: 1 })
  assert.equal(stale.accepted, false)
  assert.equal(stale.error.code, 'PROTOCOL_INVALID')

  const ok = service.saveAck({ runtimeToken: hs.runtimeToken, revision: 1 })
  assert.equal(ok.accepted, true)
  assert.equal(ok.state, 'paused')
  assert.equal(ok.lastPersistedRevision, 1)
})

test('暂停后 pause 幂等；未握手就 pause 返回状态错误', () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)
  const hs = service.handshake({
    runtimeInstanceId: 'rt-1', nonce: 'n', gameId: 'g',
    gameVersion: '1', sdkVersion: '1', bridgeVersion: 1,
  })
  assert.equal(service.pause({ runtimeToken: hs.runtimeToken, reason: 'a' }).accepted, true)
  assert.equal(service.pause({ runtimeToken: hs.runtimeToken, reason: 'b' }).accepted, true)
  assert.equal(service.pause({ runtimeToken: 'invalid', reason: 'c' }).error.code, 'PROTOCOL_INVALID')
})

test('leaseStatus 对不存在的存档返回 absent，不编造状态', () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)
  assert.deepEqual(service.leaseStatus({ runtimeToken: 'nope' }), { absent: true })
})

test('modelCatalog 是最后一个参数为 AbortSignal 的零 wire 参数方法', async () => {
  const root = new Context()
  root.provide('llm')
  root.llm = {
    async listProviders() { return ['p'] },
    async listModels() { return [{ id: 'm' }] },
  }
  const service = defineGameCenterService(makeCore(), root)

  assert.equal(service.modelCatalog.length, 1, 'wire 参数为 0，末尾只留 signal 位')

  const controller = new AbortController()
  const result = await service.modelCatalog(controller.signal)
  assert.equal(result.available, true)
  assert.equal(result.entries.length, 1)

  controller.abort()
  const aborted = await service.modelCatalog(controller.signal)
  assert.equal(aborted.available, false, '已取消的调用不得继续读目录')
})

test('modelCatalog 在 ctx.llm 缺失时返回 available:false', async () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)
  const result = await service.modelCatalog(new AbortController().signal)
  assert.equal(result.available, false)
})
