import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertNoSensitiveFields,
  projectModelEntry,
  readModelCatalog,
} from '../src/ai/model-catalog.ts'

test('目录条目绝不从输入模态推出输出模态', () => {
  const entry = projectModelEntry({
    providerId: 'deepseek',
    model: { id: 'vision-1', inputModalities: ['text', 'image'] },
  })
  assert.ok(entry)
  assert.deepEqual(entry.inputModalities, ['text', 'image'])
  assert.deepEqual(entry.outputModalities, [])
  assert.equal(entry.status, 'unknown', '没有 adapter 证据时必须是 unknown')
  assert.equal(entry.evidence, 'dsh-catalog')
})

test('元数据缺失 → 输入模态为空数组（unknown），不默认支持', () => {
  const entry = projectModelEntry({ providerId: 'p', model: { id: 'm' } })
  assert.ok(entry)
  assert.deepEqual(entry.inputModalities, [])
  assert.equal(entry.status, 'unknown')
})

test('未知模态值被丢弃，不做猜测', () => {
  const entry = projectModelEntry({
    providerId: 'p',
    model: { id: 'm', inputModalities: ['text', 'hologram', 42] },
  })
  assert.ok(entry)
  assert.deepEqual(entry.inputModalities, ['text'])
})

test('没有 id/model/name 的模型对象被跳过', () => {
  assert.equal(projectModelEntry({ providerId: 'p', model: { display: 'x' } }), null)
  assert.equal(projectModelEntry({ providerId: 'p', model: 'bare-string' }), null)
})

test('limits 只在数值合法时出现', () => {
  const entry = projectModelEntry({
    providerId: 'p',
    model: { id: 'm', contextWindow: 128000, maxOutputTokens: -1 },
  })
  assert.ok(entry)
  assert.equal(entry.limits.contextTokens, 128000)
  assert.equal(entry.limits.outputTokens, undefined, '非法值不能被写成 0 或负数')
})

test('白名单：条目不含任何敏感字段', () => {
  const entry = projectModelEntry({ providerId: 'p', model: { id: 'm' } })
  assert.ok(entry)
  assert.deepEqual(assertNoSensitiveFields(entry), [])
})

test('即使 DSH 目录对象带敏感字段，投影结果也不携带', () => {
  const entry = projectModelEntry({
    providerId: 'p',
    model: {
      id: 'm',
      apiKey: 'sk-should-never-appear',
      baseURL: 'https://internal.example',
      account: 'player@example.com',
    },
  })
  assert.ok(entry)
  const serialized = JSON.stringify(entry)
  assert.equal(serialized.includes('sk-should-never-appear'), false)
  assert.equal(serialized.includes('internal.example'), false)
  assert.equal(serialized.includes('player@example.com'), false)
})

test('readModelCatalog：llm 不可用时如实返回 available:false，而不是空列表冒充成功', async () => {
  const result = await readModelCatalog(undefined)
  assert.equal(result.available, false)
  assert.deepEqual(result.entries, [])
})

test('readModelCatalog：逐个 provider 读取，单个失败不影响其它', async () => {
  const calls = []
  const llm = {
    async listProviders() {
      return ['ok-provider', 'broken-provider']
    },
    async listModels(providerId) {
      calls.push(providerId)
      if (providerId === 'broken-provider') throw new Error('quota exceeded')
      return [{ id: 'm1' }, { id: 'm2' }]
    },
  }
  const result = await readModelCatalog(llm)
  assert.equal(result.available, true)
  assert.equal(result.entries.length, 2)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].providerId, 'broken-provider')
  assert.deepEqual(calls, ['ok-provider', 'broken-provider'])
})

test('只读：目录读取路径不包含任何 stream 调用', async () => {
  let streamCalled = false
  const llm = {
    async listProviders() {
      return ['p']
    },
    async listModels() {
      return [{ id: 'm' }]
    },
    async stream() {
      streamCalled = true
      throw new Error('不应该被调用')
    },
  }
  await readModelCatalog(llm)
  assert.equal(streamCalled, false, '阶段0 不得触发任何模型调用')
})
