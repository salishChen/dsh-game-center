import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createGameCenterContribution,
  gameCenterDescriptors,
  validateContributionShape,
} from '../src/remote/contribution-shape.ts'

test('五个方法的 descriptor 全部通过形状校验（codec 都是 strict）', () => {
  const violations = validateContributionShape(createGameCenterContribution())
  assert.deepEqual(violations, [])
})

test('方法名与 Host 侧实现一一对应', () => {
  const names = gameCenterDescriptors().map((d) => d.method)
  assert.deepEqual(names, ['handshake', 'pause', 'saveAck', 'leaseStatus', 'modelCatalog'])
  for (const d of gameCenterDescriptors()) {
    assert.equal(d.namespace, 'gameCenter')
    assert.equal(d.invocation.kind, 'direct')
  }
})

test('modelCatalog 是零 wire 参数且声明 cancellation', () => {
  const descriptor = gameCenterDescriptors().find((d) => d.method === 'modelCatalog')
  assert.deepEqual(descriptor.parameters, [])
  assert.notEqual(descriptor.cancellation, undefined, '不声明 cancellation 时 Host 不会注入 AbortSignal')
})

test('复刻 requireStrictInputs：codec.mode 不是 strict 时判违规', () => {
  const broken = {
    package: 'x',
    descriptors: [{
      namespace: 'gameCenter',
      method: 'handshake',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'src-json' } }],
      result: { mode: 'strict' },
    }],
  }
  const violations = validateContributionShape(broken)
  // 这份样本同时缺 id/service，所以不止一条违规；这里只断言 codec 那一项。
  const codecViolation = violations.find((v) => v.field === 'input')
  assert.ok(codecViolation, '必须报出参数 codec 违规')
  assert.equal(codecViolation.gate, 'gateway')
  assert.match(codecViolation.reason, /strict/)
})

test('重复的 namespace+method 会被查出', () => {
  const dup = createGameCenterContribution()
  dup.descriptors.push({ ...dup.descriptors[0] })
  const violations = validateContributionShape(dup)
  assert.ok(violations.some((v) => v.reason.includes('重复')))
})

test('非 direct invocation 会被查出', () => {
  const scoped = createGameCenterContribution()
  scoped.descriptors[0] = {
    ...scoped.descriptors[0],
    invocation: { kind: 'context', context: 'agent', wire: 'agentId', codec: { mode: 'strict' } },
  }
  const violations = validateContributionShape(scoped)
  assert.ok(violations.some((v) => v.field === 'invocation.kind'))
})

// ---- 以下守卫针对「typert 道」的五项要求（此前我漏了整道闸门）----

/**
 * 取一份合法 descriptor 的深拷贝，便于逐项破坏。
 * 不用 structuredClone：descriptor 含 create 函数，structuredClone 会抛 DataCloneError。
 */
function cloneDescriptor(index = 0) {
  const source = gameCenterDescriptors()[index]
  return {
    ...source,
    invocation: { ...source.invocation },
    parameters: source.parameters.map((parameter) => ({
      ...parameter,
      codec: { ...parameter.codec },
    })),
    result: { ...source.result },
    ...(source.cancellation === undefined ? {} : { cancellation: { ...source.cancellation } }),
  }
}

function withDescriptor(descriptor) {
  return { package: '@dsh-gamecenter/client', descriptors: [descriptor] }
}

test('typert 道：缺 descriptor.id 会被查出（validateNonempty）', () => {
  const d = cloneDescriptor()
  delete d.id
  const v = validateContributionShape(withDescriptor(d))
  assert.ok(v.some((x) => x.gate === 'typert' && x.field === 'id'))
})

test('typert 道：service 含 "#" 会被查出（validateSegment）', () => {
  const d = cloneDescriptor()
  d.service = 'dsh#gamecenter'
  const v = validateContributionShape(withDescriptor(d))
  assert.ok(v.some((x) => x.gate === 'typert' && x.field === 'service'))
})

test('typert 道：strict codec 缺 typeSymbol 会被查出', () => {
  const d = cloneDescriptor()
  d.parameters[0].codec.typeSymbol = ''
  const v = validateContributionShape(withDescriptor(d))
  assert.ok(v.some((x) => x.gate === 'typert' && x.field.endsWith('typeSymbol')))
})

test('typert 道：strict codec 缺 create() 会被查出', () => {
  const d = cloneDescriptor()
  delete d.parameters[0].codec.create
  const v = validateContributionShape(withDescriptor(d))
  assert.ok(v.some((x) => x.gate === 'typert' && x.field.endsWith('create')))
})

test('typert 道：cancellation.parameter 不是 "signal" 会被查出', () => {
  const d = cloneDescriptor(4) // modelCatalog
  d.cancellation = { parameter: 'abort' }
  const v = validateContributionShape(withDescriptor(d))
  assert.ok(v.some((x) => x.gate === 'typert' && x.field === 'cancellation.parameter'))
})

test('typert 道：wire 字段重复会被查出', () => {
  const d = cloneDescriptor()
  d.parameters.push({ ...{ ...d.parameters[0], codec: { ...d.parameters[0].codec } } })
  const v = validateContributionShape(withDescriptor(d))
  assert.ok(v.some((x) => x.reason.includes('重复')))
})

test('typert 道：namespace 含非法字符会被查出（validateWireName）', () => {
  const d = cloneDescriptor()
  d.namespace = 'game center'
  const v = validateContributionShape(withDescriptor(d))
  assert.ok(v.some((x) => x.field === 'namespace'))
})

test('反向对照：id 含 "#" 是合法的（只过 validateNonempty）', () => {
  const d = cloneDescriptor()
  d.id = 'a#b#c'
  const v = validateContributionShape(withDescriptor(d))
  assert.equal(v.length, 0, 'id 允许含 #，不应被 validateSegment 约束')
})

test('两条闸门都在校验器里：违规项能区分 gateway / typert', () => {
  const d = cloneDescriptor()
  d.parameters[0].codec = { mode: 'src-json' }
  delete d.id
  const v = validateContributionShape(withDescriptor(d))
  assert.ok(v.some((x) => x.gate === 'gateway'))
  assert.ok(v.some((x) => x.gate === 'typert'))
})
