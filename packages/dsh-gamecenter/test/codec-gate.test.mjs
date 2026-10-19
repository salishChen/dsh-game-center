import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 复刻实装源码里**两层** codec 校验，并断言在 $mount 路径上的真实先后顺序。
 *
 * 事实来源（0.2.1-rc.2 / 332895e0…，只读核实）：
 * - gateway `client.browser.js` @63022 `mountContribution`：
 *     this.validateContribution(contribution);              // 先
 *     callerCtx.typert.remotes.register(contribution);       // 后
 * - gateway `validateContribution`：对**每个** descriptor 无条件调用 `requireStrictInputs`。
 * - gateway `requireStrictCodec`：`codec.mode !== "strict"` 直接 throw。
 * - registry `client.browser.js` @24747 `validateCodec`：
 *     `if (codec.mode === "src-json") return;` → src-json 在这一层放行。
 *
 * 结论：src-json 在 registry 层确实合法，但**走不到那一层**——
 * gateway 的挂载校验先抛。所以「用 src-json 降低成本」这个判断在本版本**不成立**。
 */

// ---- 复刻 gateway 层（挂载门禁）----
function requireStrictCodec(codec, endpoint, field) {
  if (codec.mode !== 'strict') {
    throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`)
  }
}

function requireStrictInputs(descriptor) {
  const endpoint = `${descriptor.namespace}/${descriptor.method}`
  for (const parameter of descriptor.parameters) requireStrictCodec(parameter.codec, endpoint, parameter.wire)
  if (descriptor.uplink !== undefined) requireStrictCodec(descriptor.uplink.codec, endpoint, 'uplink')
  if (descriptor.invocation.kind === 'context') {
    requireStrictCodec(descriptor.invocation.codec, endpoint, descriptor.invocation.wire)
  }
}

function gatewayValidateContribution(contribution) {
  for (const descriptor of contribution.descriptors) {
    requireStrictInputs(descriptor)
  }
}

// ---- 复刻 registry 层（register 时）----
function registryValidateCodec(codec, subject) {
  if (codec.mode === 'src-json') return
  if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) {
    throw new Error(`typert: ${subject} type symbol — must be nonempty`)
  }
  if (typeof codec.create !== 'function') {
    throw new Error(`typert: ${subject} strict codec has no create() factory`)
  }
}

function registryRegister(contribution) {
  for (const descriptor of contribution.descriptors) {
    for (const parameter of descriptor.parameters) {
      registryValidateCodec(parameter.codec, `${descriptor.namespace}/${descriptor.method} ${parameter.wire}`)
    }
    registryValidateCodec(descriptor.result, `${descriptor.namespace}/${descriptor.method} result`)
  }
  return () => {}
}

/** 按实装顺序：先 gateway 校验，再 registry 注册。 */
function mountContribution(contribution) {
  gatewayValidateContribution(contribution)
  return registryRegister(contribution)
}

const srcJsonContribution = {
  package: '@test/src-json',
  descriptors: [{
    namespace: 'gameCenter',
    method: 'handshake',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'src-json' } }],
    result: { mode: 'src-json' },
  }],
}

test('registry 层单独看，src-json 确实放行（架构负责人的观察成立）', () => {
  assert.doesNotThrow(() => registryRegister(srcJsonContribution))
})

test('gateway 挂载层会拒绝 src-json 参数 codec', () => {
  assert.throws(
    () => gatewayValidateContribution(srcJsonContribution),
    /has no strict codec/,
  )
})

/**
 * 边界精确化（测试与发布负责人指出，我复核后确认）：
 * `requireStrictInputs` 只查 parameters / uplink / context 三处 codec，
 * **不查 result**。所以正确结论是「参数不能用 src-json，result 可以用」，
 * 不是我此前的「src-json 不行」。
 */
test('仅 result 用 src-json：gateway 层放行（result 不在门禁内）', () => {
  const resultOnly = {
    package: '@test/result-src-json',
    descriptors: [{
      id: '@test/result-src-json#gameCenter.handshake',
      service: 'gameCenter',
      namespace: 'gameCenter',
      method: 'handshake',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'input',
        wire: 'input',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'x#In', create: () => ({}) },
      }],
      result: { mode: 'src-json' },
    }],
  }
  assert.doesNotThrow(() => gatewayValidateContribution(resultOnly))
})

test('仅 result 用 src-json：registry 层也放行（validateCodec 对 src-json 直接 return）', () => {
  const resultOnly = {
    package: '@test/result-src-json',
    descriptors: [{
      id: '@test/result-src-json#gameCenter.handshake',
      service: 'gameCenter',
      namespace: 'gameCenter',
      method: 'handshake',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'input',
        wire: 'input',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'x#In', create: () => ({}) },
      }],
      result: { mode: 'src-json' },
    }],
  }
  assert.doesNotThrow(() => registryRegister(resultOnly))
})

test('参数 strict + result src-json：按实装顺序完整 $mount 通过', () => {
  const mixed = {
    package: '@test/mixed',
    descriptors: [{
      id: '@test/mixed#gameCenter.handshake',
      service: 'gameCenter',
      namespace: 'gameCenter',
      method: 'handshake',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'input',
        wire: 'input',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'x#In', create: () => ({}) },
      }],
      result: { mode: 'src-json' },
    }],
  }
  assert.doesNotThrow(() => mountContribution(mixed))
})

test('按实装顺序 $mount：src-json 在 gateway 层就被拒，走不到 registry', () => {
  assert.throws(() => mountContribution(srcJsonContribution), /has no strict codec/)
})

test('strict codec 必须带 typeSymbol 与 create()（registry 层要求）', () => {
  const bare = {
    package: '@test/bare-strict',
    descriptors: [{
      namespace: 'gameCenter',
      method: 'handshake',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict' } }],
      result: { mode: 'strict' },
    }],
  }
  // gateway 层放行（只要 mode 是 strict）……
  assert.doesNotThrow(() => gatewayValidateContribution(bare))
  // ……但 registry 层要求 typeSymbol + create()。
  assert.throws(() => registryRegister(bare), /type symbol/)
})

test('补齐 typeSymbol 与 create() 后两层都通过', () => {
  const full = {
    package: '@test/full-strict',
    descriptors: [{
      namespace: 'gameCenter',
      method: 'handshake',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'input',
        wire: 'input',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'gamecenter#HandshakeInput', create: () => ({}) },
      }],
      result: { mode: 'strict', typeSymbol: 'gamecenter#HandshakeOutput', create: () => ({}) },
    }],
  }
  assert.doesNotThrow(() => mountContribution(full))
})

test('零参数 + 取消的方法：parameters 为空数组即通过 gateway 校验', () => {
  const noParams = {
    package: '@test/zero-param',
    descriptors: [{
      namespace: 'gameCenter',
      method: 'modelCatalog',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: 'x#Y', create: () => ({}) },
      cancellation: { signal: 'abort' },
    }],
  }
  assert.doesNotThrow(() => mountContribution(noParams))
})
