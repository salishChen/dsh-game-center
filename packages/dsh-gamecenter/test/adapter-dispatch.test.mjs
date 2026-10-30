import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { apply, digestToken, inject, MemorySaveBackend } from '../staging/index.js'

function collectSrcClaims(ctx) {
  const claims = new Set()
  for (const [serviceKey, definition] of Object.entries(ctx.reflect.props)) {
    if (definition.type !== 'service') continue
    const receiver = ctx.get(serviceKey)
    if (!receiver) continue
    const binding = Reflect.get(receiver, 'typertRemote')
    if (!binding || typeof binding !== 'object') continue
    const namespace = Reflect.get(binding, 'namespace')
    if (typeof namespace !== 'string') continue
    for (const candidate of remoteMethods(receiver)) {
      claims.add(`${namespace}/${candidate.exportName ?? candidate.method}`)
    }
  }
  return [...claims].sort()
}

test('inject 只声明 llm，不依赖 typertGateway', () => {
  assert.deepEqual([...inject], ['llm'])
})

test('缺少 playerId 时必须显式抛错拒绝启动，严禁静默回退', () => {
  const root = new Context()
  assert.throws(
    () => apply(root, { storageBackend: new MemorySaveBackend() }),
    /无法解析受信宿主 playerId/,
  )
})

test('生产路径缺少 dataDir 且无 storageBackend 时必须显式抛错拒绝启动', () => {
  const root = new Context()
  assert.throws(
    () => apply(root, { playerId: 'test-player' }),
    /缺少必要配置 options.dataDir/,
  )
})

test('提供合法配置时 apply(ctx) 成功装配且 remoteMounted=true', () => {
  const root = new Context()
  const api = apply(root, {
    playerId: 'test-player',
    storageBackend: new MemorySaveBackend(),
  })
  assert.equal(api.remoteMounted, true, '必须装配成功')
  assert.ok(api.core, '核心逻辑对象就绪')
  assert.equal(api.playerId, 'test-player')
})

test('生产入口向 Cordis 注册 gameCenter 服务且具备 typertRemote', () => {
  const root = new Context()
  apply(root, {
    playerId: 'test-player',
    storageBackend: new MemorySaveBackend(),
  })
  assert.ok(root.reflect.props['gameCenter'], 'ctx.reflect.props 必须包含 gameCenter 服务登记')
  assert.equal(root.reflect.props['gameCenter'].type, 'service')
  const service = root.get('gameCenter')
  assert.ok(service, '服务实例已挂载到 context')
  assert.equal(service.typertRemote?.namespace, 'gameCenter')
  assert.equal(service.typertRemote?.serviceKey, 'gameCenter')
})

test('生产入口装配后，Gateway collectSrcClaims 必须认领全部 15 个端点', () => {
  const root = new Context()
  apply(root, {
    playerId: 'test-player',
    storageBackend: new MemorySaveBackend(),
  })
  const claims = collectSrcClaims(root)
  assert.deepEqual(claims, [
    'gameCenter/abandonRuntime',
    'gameCenter/aiGenerate',
    'gameCenter/setAiBinding',
    'gameCenter/suspendRuntime',
    'gameCenter/resumeRuntime',
    'gameCenter/cancelAi',
    'gameCenter/landlordAction',
    'gameCenter/walletStatus',
    'gameCenter/walletAction',
    'gameCenter/arenaAction',
    'gameCenter/catalogInstall',
    'gameCenter/catalogUninstall',
    'gameCenter/catalogList',
    'gameCenter/gameBundle',
    'gameCenter/handshake',
    'gameCenter/leaseStatus',
    'gameCenter/mediaFetch',
    'gameCenter/modelCatalog',
    'gameCenter/pause',
    'gameCenter/previewBundle',
    'gameCenter/previewList',
    'gameCenter/saveAck',
    'gameCenter/saveCheckpoint',
    'gameCenter/saveLatest',
  ].sort())
})

test('apply 对非 Cordis 上下文抛错，不静默空转', () => {
  assert.throws(() => apply({}), TypeError)
  assert.throws(() => apply(null), TypeError)
  assert.throws(() => apply({ effect: 'not-a-function' }), TypeError)
})

test('注册插件生命周期 effect（卸载时可清理）', () => {
  const root = new Context()
  const api = apply(root, {
    playerId: 'test-player',
    storageBackend: new MemorySaveBackend(),
  })
  assert.equal(typeof api.dispose, 'function')
  api.dispose()
})

test('apply 注册真实定时扫描器（无人读写自动回收），并在 dispose 时停表', async () => {
  const root = new Context()
  const nowRef = { now: Date.parse('2026-10-19T00:00:00.000Z') }
  const api = apply(root, {
    playerId: 'test-player',
    storageBackend: new MemorySaveBackend(),
    scanIntervalMs: 20,
    nowMs: () => nowRef.now,
  })
  assert.equal(api.scanIntervalMs, 20)

  // 1. 建立未确认的 pending 租约
  const hs = api.core.handshake({
    runtimeInstanceId: 'rt-timer-auto',
    nonce: 'n-timer',
    gameId: 'test.timer.game',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  assert.equal(hs.ok, true)
  assert.equal(api.core.inspect('test.timer.game')[0].state, 'pending')

  // 2. 完全不再调用任何 Remote，仅模拟时间推进越过 T_ack (3000ms)
  nowRef.now += 3500

  // 3. 等待后台真实定时器触发一次 sweep（不依赖任何主动读写）
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(
    api.core.inspect('test.timer.game')[0].state,
    'stopped',
    '无人读写时，后台定时器必须主动回收未确认租约',
  )

  // 4. dispose 停表测试
  api.dispose()
})

test('digestToken 不包含原文', () => {
  const digest = digestToken('super-secret-token')
  assert.equal(digest.includes('super-secret-token'), false)
  assert.match(digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(digest, digestToken('super-secret-token'))
  assert.notEqual(digest, digestToken('super-secret-tokeN'))
})
