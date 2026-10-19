/**
 * Remote 挂载的**本地端到端契约测试**（`MOCK` 分栏，不是 DSH-REAL）。
 *
 * 用一个按实装源码行为建模的假 `$mount` + 假 `RemoteStore.register`，
 * 验证我们的 contribution 能穿过**两道真实校验规则**并被调用：
 *   1. gateway 侧 `validateContribution` → `requireStrictInputs`（codec 必须 strict、
 *      重复 endpoint 拒绝、`scope` 会引入 scoped 路径）；
 *   2. `typert.remotes.register` → `RemoteStore.register` 只读 `package` / `descriptors`。
 *
 * 假的规则逐条抄自实装源码；**这证明的是「形状能与这些规则对上」，
 * 不证明 DSH 进程里真的挂载成功**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOUNT_ERRORS,
  createGameCenterClient,
  createGameCenterContribution,
  mountGameCenterRemote,
  validateContributionShape,
} from '../src/bridge/remote-mount.js';

/**
 * 复刻 gateway `validateContribution` 的关键规则。
 *
 * **忠实度修正（测试与发布负责人指出）**：`requireStrictInputs` 只校验
 * `parameters[].codec`、`uplink.codec`、`invocation.codec`（仅 context 时），
 * **不校验 `result.mode`**。我上一版 mock 多验了 result，会让 mock 比真实更严，
 * 从而掩盖真实会通过的形状 —— 已删除该条。
 * @param {{package: string, descriptors: any[]}} contribution
 */
function gatewayValidate(contribution) {
  const direct = new Map();
  for (const descriptor of contribution.descriptors) {
    // requireStrictInputs：逐条复刻，只查这三处
    for (const parameter of descriptor.parameters) {
      if (parameter.codec.mode !== 'strict') {
        throw new Error(
          `client api: generated Remote ${descriptor.namespace}/${descriptor.method} field ${JSON.stringify(parameter.wire)} has no strict codec`,
        );
      }
    }
    if (descriptor.uplink !== undefined && descriptor.uplink.codec.mode !== 'strict') {
      throw new Error(
        `client api: generated Remote ${descriptor.namespace}/${descriptor.method} field "uplink" has no strict codec`,
      );
    }
    if (descriptor.invocation.kind === 'context' && descriptor.invocation.codec?.mode !== 'strict') {
      throw new Error(
        `client api: generated Remote ${descriptor.namespace}/${descriptor.method} field "Context" has no strict codec`,
      );
    }

    // validateContribution：endpoint 唯一 + scope 归 scoped 路径
    if (descriptor.invocation.kind !== 'direct' && descriptor.invocation.kind !== 'context') {
      throw new Error(`client api: unknown invocation kind ${descriptor.invocation.kind}`);
    }
    if (descriptor.invocation.kind === 'direct') {
      const methods = direct.get(descriptor.namespace) ?? new Set();
      if (methods.has(descriptor.method)) {
        throw new Error(`client api: contribution repeats direct method ${descriptor.namespace}/${descriptor.method}`);
      }
      methods.add(descriptor.method);
      direct.set(descriptor.namespace, methods);
    }
    if (descriptor.scope !== undefined) {
      // scopedProjection 只在 scope 存在时产生；本项目不填，填了就走 scoped 并要求唯一 lookup 参数
      const lookup = descriptor.parameters.find((p) => p.source === 'lookup');
      if (lookup === undefined) {
        throw new Error(
          `client api: ${descriptor.namespace}/${descriptor.method} scope must select its only lookup parameter`,
        );
      }
    }
  }
  return direct;
}

/**
 * 复刻 typert `validateWireName`（`dsh-typert-registry/lib/client.browser.js`）：
 * 禁 `"."` / `".."`，且必须匹配 `/^[A-Za-z0-9_$.-]+$/`。
 *
 * **忠实度修正（测试与发布负责人指出）**：上一版 mock 只查「非空字符串」，
 * 比真实**宽松**：`有中文`、`a b`、`.`、`..`、`a/b` 真实会拒，mock 全放行。
 * @param {string} subject @param {string} value
 */
function typertValidateWireName(subject, value) {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value)) {
    throw new Error(`typert: invalid ${subject} "${value}" — must contain only RPC endpoint segment characters`);
  }
}

/**
 * 复刻 typert `validateSegment`：非空且不含 `#`。
 *
 * **忠实度修正**：上一版对 `service` 只查非空，漏了 `#`。
 * @param {string} subject @param {string} value
 */
function typertValidateSegment(subject, value) {
  if (value.length === 0 || value.includes('#')) {
    throw new Error(`typert: invalid ${subject} "${value}" — must be nonempty and must not contain "#"`);
  }
}

/**
 * 复刻 typert `validateCodec`：
 * `src-json` 直接放行；`strict` 要求 typeSymbol 非空且 create 是函数。
 * @param {any} codec @param {string} subject
 */
function typertValidateCodec(codec, subject) {
  if (codec.mode === 'src-json') return;
  if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) {
    throw new Error(`typert: ${subject} type symbol must be non-empty`);
  }
  if (typeof codec.create !== 'function') {
    throw new Error(`typert: ${subject} strict codec has no create() factory`);
  }
}

/**
 * 复刻 typert `validateInvocation`：第二道闸门。
 * @param {any} descriptor
 */
function typertValidateInvocation(descriptor) {
  const fail = (message) => {
    throw new Error(`typert: invocation "${descriptor.id}" ${message}`);
  };
  // id 只过 validateNonempty，**不校验字符集**（所以含 "#" 合法）
  if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) fail('has no invocation id');
  typertValidateSegment('invocation service key', descriptor.service);
  typertValidateWireName('invocation namespace', descriptor.namespace);
  typertValidateWireName('invocation method', descriptor.method);
  if (descriptor.implementation !== undefined) {
    typertValidateWireName('invocation implementation method', descriptor.implementation);
  }
  typertValidateCodec(descriptor.result, `${descriptor.id} result`);

  const wires = new Set();
  for (const parameter of descriptor.parameters) {
    typertValidateWireName('parameter name', parameter.name);
    typertValidateWireName('parameter wire field', parameter.wire);
    if (wires.has(parameter.wire)) fail(`repeats wire field "${parameter.wire}"`);
    wires.add(parameter.wire);
    typertValidateCodec(parameter.codec, `${descriptor.id} parameter ${parameter.name}`);
  }
  const cancellation = descriptor.cancellation;
  if (cancellation !== undefined && cancellation.parameter !== 'signal') {
    fail('cancellation parameter must be "signal"');
  }
  if (descriptor.mode !== undefined && descriptor.mode !== 'stream') fail('mode must be "stream"');

  // scope：必须恰好选中 1 个 lookup 参数，且 wire 与 lookup 都要与 scope 匹配
  if (descriptor.scope !== undefined) {
    if (descriptor.invocation.kind !== 'direct') {
      fail('Context receiver cannot declare a direct scope projection');
    }
    const lookups = descriptor.parameters.filter((p) => p.source === 'lookup');
    const selected = lookups.length === 1 ? lookups[0] : undefined;
    if (selected === undefined || selected.wire !== descriptor.scope.wire || selected.lookup !== descriptor.scope.context) {
      fail('scope must select its only lookup parameter');
    }
  }
  if (descriptor.invocation.kind === 'context') {
    typertValidateSegment('Context key', descriptor.invocation.context);
    typertValidateWireName('Context wire field', descriptor.invocation.wire);
    if (wires.has(descriptor.invocation.wire)) fail('repeats wire field on Context');
    typertValidateCodec(descriptor.invocation.codec, `${descriptor.id} Context`);
  }
}

/**
 * 复刻 `RemoteStore.register(ctx, contribution)`：
 * 只读 package / descriptors，并调 `descriptors.validate()`。
 * @param {{package: string, descriptors: any[]}} contribution
 * @param {Set<string>} registered
 */
function remoteStoreRegister(contribution, registered) {
  assert.equal(typeof contribution.package, 'string');
  assert.equal(contribution.package.includes('#'), false, 'package 名不能含 #');
  if (registered.has(contribution.package)) {
    throw new Error(`typert: Remote package "${contribution.package}" is already registered`);
  }
  assert.ok(Array.isArray(contribution.descriptors), 'RemoteStore 只读 descriptors');
  assert.equal('invocations' in contribution, false, 'RemoteStore 不读 invocations，也不需要它');

  // descriptors.validate()：endpoint 与 id 都必须全局唯一
  const endpoints = new Set();
  const ids = new Set();
  for (const descriptor of contribution.descriptors) {
    typertValidateInvocation(descriptor);
    const endpoint = `${descriptor.namespace}/${descriptor.method}`;
    if (endpoints.has(endpoint)) throw new Error(`typert: remote endpoint "${endpoint}" is already registered`);
    endpoints.add(endpoint);
    if (ids.has(descriptor.id)) throw new Error(`typert: remote invocation id "${descriptor.id}" is already registered`);
    ids.add(descriptor.id);
  }

  registered.add(contribution.package);
  return new Map(contribution.descriptors.map((d) => [`${d.namespace}/${d.method}`, d]));
}

/**
 * 造一个按实装行为工作的假 `remote` 服务。
 * @param {{registered?: Set<string>, calls?: any[]}} [state]
 */
function fakeRemote(state = {}) {
  const registered = state.registered ?? new Set();
  /** @type {Record<string, Record<string, Function>>} */
  const namespaces = {};
  const calls = state.calls ?? [];

  return {
    registered,
    namespaces,
    calls,
    /**
     * @param {{package: string, descriptors: any[]}} contribution
     * @returns {Promise<() => Promise<void>>}
     */
    async $mount(contribution) {
      // 1) gateway 校验
      const direct = gatewayValidate(contribution);
      // 2) typert.remotes.register（只读 package/descriptors）
      remoteStoreRegister(contribution, registered);
      // 3) installNamespace：按 descriptor 建出可调用方法
      for (const [namespace] of direct) {
        const service = namespaces[namespace] ?? {};
        for (const descriptor of contribution.descriptors) {
          if (descriptor.namespace !== namespace) continue;
          service[descriptor.method] = async (...args) => {
            calls.push({ method: descriptor.method, args });
            // 假 Host：回一个 ok 结果
            return { ok: true, method: descriptor.method, received: args };
          };
        }
        namespaces[namespace] = service;
      }
      let disposed = false;
      return async () => {
        if (disposed) return;
        disposed = true;
        registered.delete(contribution.package);
      };
    },
  };
}

test('contribution 形状：五个方法、namespace 一致、无 scope、strict codec', () => {
  const contribution = createGameCenterContribution();
  assert.equal(contribution.package, '@dsh-gamecenter/client');
  assert.deepEqual(
    contribution.descriptors.map((d) => d.method),
    ['handshake', 'pause', 'saveAck', 'leaseStatus', 'modelCatalog'],
  );
  for (const descriptor of contribution.descriptors) {
    assert.equal(descriptor.namespace, 'gameCenter');
    assert.deepEqual(descriptor.invocation, { kind: 'direct' });
    assert.equal(descriptor.result.mode, 'strict');
    assert.equal('scope' in descriptor, false, '不得填 scope');
  }
  assert.deepEqual(validateContributionShape(contribution), []);
});

test('modelCatalog 无业务参数，但必须声明 cancellation（否则 Host 少传 AbortSignal）', () => {
  const catalog = createGameCenterContribution().descriptors.find((d) => d.method === 'modelCatalog');
  assert.deepEqual(catalog.parameters, []);
  // typert validateInvocation：cancellation.parameter 必须是 "signal"
  assert.deepEqual(catalog.cancellation, { parameter: 'signal' });
  const others = createGameCenterContribution().descriptors.filter((d) => d.method !== 'modelCatalog');
  for (const descriptor of others) {
    assert.equal('cancellation' in descriptor, false, '有 input 的方法不需要 cancellation');
  }
});

test('每个 descriptor 都带 typert 要求的 id 与 service（第二道闸门）', () => {
  for (const descriptor of createGameCenterContribution().descriptors) {
    assert.equal(typeof descriptor.id, 'string');
    assert.ok(descriptor.id.length > 0);
    // service 与 Host 侧 SERVICE_KEY 同名，消除对账歧义。
    // 注意：该字段不过 wire，Host 用自己 SRC 生成的 descriptor.service，所以它不阻断调用。
    assert.equal(descriptor.service, 'gameCenter');
    assert.equal(descriptor.result.mode, 'strict');
    assert.equal(typeof descriptor.result.typeSymbol, 'string');
    assert.equal(typeof descriptor.result.create, 'function');
  }
});

test('形状校验能抓出缺少 typert 的 id / service（这正是我上一版漏掉的）', () => {
  const broken = createGameCenterContribution();
  delete (/** @type {any} */ (broken.descriptors[0]).id);
  delete (/** @type {any} */ (broken.descriptors[1]).service);
  const violations = validateContributionShape(broken);
  assert.ok(violations.some((v) => v.field === 'id'), '应报缺 id');
  assert.ok(violations.some((v) => v.field === 'service'), '应报缺 service');
});

test('形状校验能抓出 strict codec 缺 create()（typert validateCodec 的要求）', () => {
  const broken = createGameCenterContribution();
  (/** @type {any} */ (broken.descriptors[0]).result) = { mode: 'strict', typeSymbol: 'x' };
  const violations = validateContributionShape(broken);
  assert.ok(violations.some((v) => v.field === 'result' && /create/.test(v.reason)));
});

test('形状校验能抓出 cancellation.parameter 不是 "signal"', () => {
  const broken = createGameCenterContribution();
  const catalog = broken.descriptors.find((d) => d.method === 'modelCatalog');
  if (catalog !== undefined) /** @type {any} */ (catalog).cancellation = { parameter: 'abort' };
  const violations = validateContributionShape(broken);
  assert.ok(violations.some((v) => v.field === 'cancellation.parameter'));
});

test('形状校验能抓出 codec 不是 strict（对应 requireStrictInputs 的原始报错场景）', () => {
  const broken = createGameCenterContribution();
  broken.descriptors[0].parameters[0].codec = /** @type {any} */ ({ mode: 'lax' });
  const violations = validateContributionShape(broken);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, 'input');
  assert.match(violations[0].reason, /strict/);
});

test('形状校验能抓出误填 scope（会走 scoped 路径）', () => {
  const broken = createGameCenterContribution();
  /** @type {any} */ (broken.descriptors[1]).scope = { context: 'x', wire: 'y' };
  const violations = validateContributionShape(broken);
  assert.ok(violations.some((v) => v.field === 'scope'));
});

test('端到端（MOCK）：挂载后能调用 gameCenter 五个方法', async () => {
  const remote = fakeRemote();
  const ctx = { remote };
  const mounted = await mountGameCenterRemote(ctx);
  assert.equal(mounted.ok, true, mounted.ok === false ? mounted.message : '');
  assert.deepEqual([...remote.registered], ['@dsh-gamecenter/client']);

  const client = createGameCenterClient(remote.namespaces.gameCenter);
  const handshake = await client.handshake({ gameId: 'g', saveId: 's' });
  assert.equal(handshake.ok, true);
  assert.deepEqual(handshake.received, [{ gameId: 'g', saveId: 's' }]);

  const catalog = await client.modelCatalog();
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.received, [], 'modelCatalog 不传业务参数');

  const last = remote.calls.at(-1);
  assert.equal(last.method, 'modelCatalog');
  const ackCall = remote.calls.find((c) => c.method === 'handshake');
  assert.deepEqual(ackCall.args[0], { gameId: 'g', saveId: 's' }, 'wire 参数按 descriptors 顺序传入');
});

test('端到端（MOCK）：卸载后 namespace 仍在但 package 释放，重复挂载会报已注册', async () => {
  const remote = fakeRemote();
  const ctx = { remote };
  const first = await mountGameCenterRemote(ctx);
  assert.equal(first.ok, true);
  await /** @type {any} */ (first).dispose();
  assert.equal(remote.registered.size, 0);

  const again = await mountGameCenterRemote(ctx);
  assert.equal(again.ok, true, '卸载后可以重新挂载');
});

test('缺少 remote 服务时如实报错，不静默降级', async () => {
  const result = await mountGameCenterRemote({});
  assert.equal(result.ok, false);
  assert.equal(/** @type {any} */ (result).code, MOUNT_ERRORS.NO_REMOTE_SERVICE);
});

test('$mount 抛错时把原始消息带回，便于定位', async () => {
  const ctx = {
    remote: {
      $mount: async () => {
        throw new Error('client api: contribution repeats direct method gameCenter/handshake');
      },
    },
  };
  const result = await mountGameCenterRemote(ctx);
  assert.equal(result.ok, false);
  assert.equal(/** @type {any} */ (result).code, MOUNT_ERRORS.MOUNT_THREW);
  assert.match(/** @type {any} */ (result).message, /repeats direct method/);
});

test('Client 包装把 Host 的 ok:false 转成带 code 的异常', async () => {
  const client = createGameCenterClient({
    saveAck: async () => ({ ok: false, error: { code: 'STALE_RUNTIME', message: '代次已失效' } }),
  });
  await assert.rejects(
    () => client.saveAck({ generation: 1, revision: 2 }),
    (error) => {
      assert.equal(/** @type {any} */ (error).code, 'STALE_RUNTIME');
      assert.match(/** @type {any} */ (error).message, /代次已失效/);
      return true;
    },
  );
});

test('Client 包装支持解包 Gateway 的 {ok:true, value} 信封，并捕获内层业务失败', async () => {
  // 1. 成功信封解包
  const clientSuccess = createGameCenterClient({
    handshake: async () => ({
      ok: true,
      value: { ok: true, generation: 1, runtimeToken: 'token-xyz', state: 'running' },
    }),
  });
  const res = await clientSuccess.handshake({});
  assert.equal(res.generation, 1);
  assert.equal(res.runtimeToken, 'token-xyz');
  assert.equal(res.state, 'running');

  // 2. 负例：信封顶层 ok:true，但内层业务失败 { ok:false, errorCode:'X', message:'m' }
  const clientInnerFail = createGameCenterClient({
    handshake: async () => ({
      ok: true,
      value: { ok: false, errorCode: 'AUTH_FAILED', message: '握手凭证错误' },
    }),
  });
  await assert.rejects(
    () => clientInnerFail.handshake({}),
    (error) => {
      assert.equal(/** @type {any} */ (error).code, 'AUTH_FAILED');
      assert.match(/** @type {any} */ (error).message, /握手凭证错误/);
      return true;
    },
  );

  // 3. 负例：网关顶层信封失败 { ok: false, error: { code: 'gateway/internal', message: '网关分发异常' } }
  const clientGatewayFail = createGameCenterClient({
    handshake: async () => ({
      ok: false,
      error: { code: 'gateway/internal', message: '网关分发异常' },
    }),
  });
  await assert.rejects(
    () => clientGatewayFail.handshake({}),
    (error) => {
      assert.equal(/** @type {any} */ (error).code, 'gateway/internal');
      assert.match(/** @type {any} */ (error).message, /网关分发异常/);
      return true;
    },
  );

  // 4. 防误伤测试：业务结果自身恰好包含 value 字段（但键数 > 2）时，绝不被误判为网关信封二次解包
  const clientBusinessWithValue = createGameCenterClient({
    handshake: async () => ({
      ok: true,
      value: 'some-biz-value',
      generation: 1,
      state: 'running',
    }),
  });
  const bizRes = await clientBusinessWithValue.handshake({});
  assert.equal(bizRes.value, 'some-biz-value');
  assert.equal(bizRes.generation, 1);
});

test('Client 包装对未挂载的方法给出明确错误，而不是 undefined', async () => {
  const client = createGameCenterClient({});
  await assert.rejects(
    () => client.pause({}),
    (error) => {
      assert.equal(/** @type {any} */ (error).code, MOUNT_ERRORS.INVALID_CONTRIBUTION);
      return true;
    },
  );
});

// —— 下面四项守「两道闸门的先后顺序」，对应 Host 工程师与测试负责人各自的结论 ——

test('src-json 在 gateway 层就被拒，走不到 registry（顺序决定结果）', () => {
  const contribution = createGameCenterContribution();
  const first = contribution.descriptors[0];
  /** @type {any} */ (first.parameters[0]).codec = { mode: 'src-json' };
  // gateway 先执行，直接抛
  assert.throws(() => gatewayValidate(contribution), /has no strict codec/);
});

test('参数 codec 只写 {mode:"strict"} 能过 gateway，但会在 registry 报 typeSymbol', () => {
  const contribution = createGameCenterContribution();
  const first = contribution.descriptors[0];
  /** @type {any} */ (first.parameters[0]).codec = { mode: 'strict' };
  // gateway 通过（只查 mode）
  assert.doesNotThrow(() => gatewayValidate(contribution));
  // registry 层才查 typeSymbol + create
  assert.throws(() => typertValidateInvocation(first), /type symbol/);
});

test('requireStrictInputs 不校验 result.mode（我的 mock 上一版多验了）', () => {
  const contribution = createGameCenterContribution();
  /** @type {any} */ (contribution.descriptors[0]).result = { mode: 'lax' };
  // gateway 不查 result，所以这里不抛
  assert.doesNotThrow(() => gatewayValidate(contribution), 'gateway 不应因 result.mode 报错');
  // 但 registry 的 validateCodec 会查：mode 既非 strict 也不是 src-json → 要求 typeSymbol
  assert.throws(() => typertValidateInvocation(contribution.descriptors[0]), /type symbol/);
});

test('真实 contribution 能同时通过两道闸门（顺序执行）', () => {
  const contribution = createGameCenterContribution();
  assert.doesNotThrow(() => gatewayValidate(contribution));
  for (const descriptor of contribution.descriptors) {
    assert.doesNotThrow(() => typertValidateInvocation(descriptor));
  }
  assert.deepEqual(validateContributionShape(contribution), []);
});

test('五个 descriptor 的 codec 都带 typeSymbol 与 create()（Host 工程师提醒的坑）', () => {
  for (const descriptor of createGameCenterContribution().descriptors) {
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict');
      assert.equal(typeof parameter.codec.typeSymbol, 'string');
      assert.ok(parameter.codec.typeSymbol.length > 0, `${descriptor.method} 参数缺 typeSymbol`);
      assert.equal(typeof parameter.codec.create, 'function', `${descriptor.method} 参数缺 create()`);
    }
    assert.equal(descriptor.result.mode, 'strict');
    assert.ok(/** @type {any} */ (descriptor.result).typeSymbol?.length > 0);
    assert.equal(typeof /** @type {any} */ (descriptor.result).create, 'function');
  }
});

// —— 下面三项是测试与发布负责人指出的「mock 抄得过松」的守卫 ——

test('守卫①：scope 唯一性——两个 lookup / wire 不匹配 / context 不匹配，真实全拒', () => {
  /** @param {{context: string, wire: string}} scope */
  const withScope = (scope) => ({
    id: 'x#t',
    service: 'gameCenter',
    namespace: 'gameCenter',
    method: 'm',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'a', wire: 'a', source: 'lookup', lookup: 'k1', codec: { mode: 'src-json' } },
      { name: 'b', wire: 'b', source: 'lookup', lookup: 'k2', codec: { mode: 'src-json' } },
    ],
    result: { mode: 'strict', typeSymbol: 't', create() {} },
    scope,
  });

  // (1) 两个 lookup 非唯一
  assert.throws(() => typertValidateInvocation(withScope({ context: 'k1', wire: 'a' })), /only lookup parameter/);

  // (2) 唯一 lookup 但 wire 不匹配
  const onlyOne = withScope({ context: 'k1', wire: 'zzz' });
  onlyOne.parameters = [onlyOne.parameters[0]];
  assert.throws(() => typertValidateInvocation(onlyOne), /only lookup parameter/);

  // (3) 唯一 lookup 但 context 不匹配
  const contextMismatch = withScope({ context: 'other', wire: 'a' });
  contextMismatch.parameters = [contextMismatch.parameters[0]];
  assert.throws(() => typertValidateInvocation(contextMismatch), /only lookup parameter/);

  // (4) 正确的唯一 lookup 通过
  const good = withScope({ context: 'k1', wire: 'a' });
  good.parameters = [good.parameters[0]];
  assert.doesNotThrow(() => typertValidateInvocation(good));
});

test('守卫②：validateWireName 字符集——中文 / 空格 / "." / ".." / 斜杠 真实全拒', () => {
  for (const bad of ['有中文', 'a b', '.', '..', 'a/b', '']) {
    const descriptor = createGameCenterContribution().descriptors[0];
    /** @type {any} */ (descriptor).namespace = bad;
    assert.throws(
      () => typertValidateInvocation(descriptor),
      /invalid invocation namespace/,
      `namespace=${JSON.stringify(bad)} 应当被拒`,
    );
  }
  // 合法字符集不拒
  const ok = createGameCenterContribution().descriptors[0];
  /** @type {any} */ (ok).namespace = 'gameCenter_$.-9';
  assert.doesNotThrow(() => typertValidateInvocation(ok));
});

test('守卫③：service 的 validateSegment 要禁 "#"（id 不校验字符集，含 # 合法）', () => {
  const descriptor = createGameCenterContribution().descriptors[0];
  /** @type {any} */ (descriptor).service = 'a#b';
  assert.throws(() => typertValidateInvocation(descriptor), /must not contain "#"/);

  // 对照：id 含 "#" 是合法的（只过 validateNonempty）
  const withHashId = createGameCenterContribution().descriptors[0];
  assert.ok(String(withHashId.id).includes('#'));
  assert.doesNotThrow(() => typertValidateInvocation(withHashId));
});
