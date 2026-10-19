import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { apply, digestToken, inject } from '../staging/index.js'

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

test('默认生产入口 apply(ctx) 必须装配成功且 remoteMounted=true', () => {
  const root = new Context()
  const api = apply(root)
  assert.equal(api.remoteMounted, true, '默认生产路径必须装配成功，严禁静默返回 false')
  assert.ok(api.core, '核心逻辑对象就绪')
})

test('生产入口必须向 Cordis 注册 gameCenter 服务且具备 typertRemote', () => {
  const root = new Context()
  apply(root)
  assert.ok(root.reflect.props['gameCenter'], 'ctx.reflect.props 必须包含 gameCenter 服务登记')
  assert.equal(root.reflect.props['gameCenter'].type, 'service')
  const service = root.get('gameCenter')
  assert.ok(service, '服务实例已挂载到 context')
  assert.equal(service.typertRemote?.namespace, 'gameCenter')
  assert.equal(service.typertRemote?.serviceKey, 'gameCenter')
})

test('生产入口装配后，Gateway collectSrcClaims 必须认领全部 5 个端点', () => {
  const root = new Context()
  apply(root)
  const claims = collectSrcClaims(root)
  assert.deepEqual(claims, [
    'gameCenter/handshake',
    'gameCenter/leaseStatus',
    'gameCenter/modelCatalog',
    'gameCenter/pause',
    'gameCenter/saveAck',
  ])
})

test('apply 对非 Cordis 上下文抛错，不静默空转', () => {
  assert.throws(() => apply({}), TypeError)
  assert.throws(() => apply(null), TypeError)
  assert.throws(() => apply({ effect: 'not-a-function' }), TypeError)
})

test('注册插件生命周期 effect（卸载时可清理）', () => {
  const root = new Context()
  let disposed = false
  const api = apply(root)
  assert.equal(typeof api.dispose, 'function')
})

test('digestToken 不包含原文', () => {
  const digest = digestToken('super-secret-token')
  assert.equal(digest.includes('super-secret-token'), false)
  assert.match(digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(digest, digestToken('super-secret-token'))
  assert.notEqual(digest, digestToken('super-secret-tokeN'))
})
