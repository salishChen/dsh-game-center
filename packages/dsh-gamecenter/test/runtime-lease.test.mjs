import test from 'node:test'
import assert from 'node:assert/strict'

import { LeaseRegistry } from '../src/runtime/lease.ts'

const T0 = Date.parse('2026-10-18T00:00:00.000Z')

function fresh() {
  return new LeaseRegistry()
}

function acquire(registry, overrides = {}) {
  return registry.acquire({
    gameId: 'example.game',
    saveId: 'save-1',
    ttlMs: 30_000,
    generation: 1,
    runtimeInstanceId: 'rt-1',
    tokenDigest: 'noncrypto-fnv1a64:aaa',
    nowMs: T0,
    ...overrides,
  })
}

test('单存档单控制者：第二个运行实例被拒绝，且不顶替第一个', () => {
  const registry = fresh()
  const first = acquire(registry)
  assert.equal(first.ok, true)

  const second = acquire(registry, { runtimeInstanceId: 'rt-2', generation: 2 })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'STALE_RUNTIME')
  // 第一个租约仍然保持，未被顶替。
  assert.equal(registry.get('example.game', 'save-1').runtimeInstanceId, 'rt-1')
})

test('代次必须严格递增，不能复用旧代次', () => {
  const registry = fresh()
  acquire(registry, { generation: 5 })
  registry.finish('example.game', 'save-1', 5)

  const reuse = acquire(registry, { generation: 5, runtimeInstanceId: 'rt-9' })
  assert.equal(reuse.ok, false)
  assert.equal(reuse.code, 'STALE_RUNTIME')

  const next = acquire(registry, { generation: 6, runtimeInstanceId: 'rt-10' })
  assert.equal(next.ok, true)
})

test('pending 不能直接写入，握手后才能 running', () => {
  const registry = fresh()
  acquire(registry)

  const beforeHandshake = registry.checkWritable('example.game', 'save-1', 1, T0)
  assert.equal(beforeHandshake.ok, false)
  assert.equal(beforeHandshake.code, 'PROTOCOL_INVALID')

  assert.equal(registry.markRunning('example.game', 'save-1', 1, T0, 30_000).ok, true)
  assert.equal(registry.checkWritable('example.game', 'save-1', 1, T0).ok, true)
})

test('旧代次写入返回 STALE_RUNTIME，而不是笼统的 PAUSED', () => {
  const registry = fresh()
  acquire(registry, { generation: 3 })
  registry.markRunning('example.game', 'save-1', 3, T0, 30_000)

  const stale = registry.checkWritable('example.game', 'save-1', 2, T0)
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'STALE_RUNTIME')
  assert.equal(stale.details['actual'], 2)
})

test('暂停流程：pausing 期间拒新请求，确认后 paused 且封存', () => {
  const registry = fresh()
  acquire(registry)
  registry.markRunning('example.game', 'save-1', 1, T0, 30_000)

  assert.equal(registry.beginPause('example.game', 'save-1', 1).ok, true)

  const during = registry.checkWritable('example.game', 'save-1', 1, T0)
  assert.equal(during.ok, false)
  assert.equal(during.code, 'PAUSED')

  const confirmed = registry.confirmPause('example.game', 'save-1', 1, 7)
  assert.equal(confirmed.ok, true)

  const lease = registry.get('example.game', 'save-1')
  assert.equal(lease.state, 'paused')
  assert.equal(lease.sealed, true)
  assert.equal(lease.lastPersistedRevision, 7)

  const after = registry.checkWritable('example.game', 'save-1', 1, T0)
  assert.equal(after.ok, false)
  assert.equal(after.code, 'STALE_RUNTIME')
})

test('旧代次的保存确认被拒绝，且不改变状态', () => {
  const registry = fresh()
  acquire(registry, { generation: 4 })
  registry.markRunning('example.game', 'save-1', 4, T0, 30_000)
  registry.beginPause('example.game', 'save-1', 4)

  const staleAck = registry.confirmPause('example.game', 'save-1', 3, 2)
  assert.equal(staleAck.ok, false)
  assert.equal(staleAck.code, 'STALE_RUNTIME')
  assert.equal(registry.get('example.game', 'save-1').state, 'pausing')
  assert.equal(registry.get('example.game', 'save-1').lastPersistedRevision, 0)
})

test('revision 必须递增，重复确认被拒绝', () => {
  const registry = fresh()
  acquire(registry)
  registry.markRunning('example.game', 'save-1', 1, T0, 30_000)
  registry.beginPause('example.game', 'save-1', 1)
  assert.equal(registry.confirmPause('example.game', 'save-1', 1, 4).ok, true)

  const again = registry.confirmPause('example.game', 'save-1', 1, 4)
  assert.equal(again.ok, false)
  assert.equal(again.code, 'PROTOCOL_INVALID')
})

test('暂停超时回落到 recovery-available，不伪造保存成功', () => {
  const registry = fresh()
  acquire(registry)
  registry.markRunning('example.game', 'save-1', 1, T0, 30_000)
  registry.beginPause('example.game', 'save-1', 1)

  const abandoned = registry.abandonPause('example.game', 'save-1', 1, 'timeout')
  assert.equal(abandoned.ok, true)

  const lease = registry.get('example.game', 'save-1')
  assert.equal(lease.state, 'recovery-available')
  assert.equal(lease.lastPersistedRevision, 0, '超时不能产生 revision')
})

test('租约过期后拒绝写入，sweep 标记为 recovery-available', () => {
  const registry = fresh()
  acquire(registry, { ttlMs: 1_000 })
  registry.markRunning('example.game', 'save-1', 1, T0, 1_000)

  const expired = registry.checkWritable('example.game', 'save-1', 1, T0 + 5_000)
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'PAUSED')

  const swept = registry.sweepExpired(T0 + 5_000)
  assert.equal(swept.length, 1)
  assert.equal(registry.get('example.game', 'save-1').state, 'recovery-available')
})

test('不同存档互不影响（多暂停存档共存）', () => {
  const registry = fresh()
  acquire(registry, { saveId: 'save-1', generation: 1 })
  acquire(registry, { saveId: 'save-2', generation: 1, runtimeInstanceId: 'rt-2' })
  registry.markRunning('example.game', 'save-1', 1, T0, 30_000)
  registry.markRunning('example.game', 'save-2', 1, T0, 30_000)

  assert.equal(registry.beginPause('example.game', 'save-1', 1).ok, true)
  assert.equal(registry.checkWritable('example.game', 'save-2', 1, T0).ok, true)
})

test('peekByGeneration 能按代次反查', () => {
  const registry = fresh()
  acquire(registry, { generation: 11 })
  const found = registry.peekByGeneration(11)
  assert.equal(found?.saveId, 'save-1')
  assert.equal(registry.peekByGeneration(99), undefined)
})
