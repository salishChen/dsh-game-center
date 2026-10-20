// @ts-check
/**
 * 诊断逻辑与 Remote 失败形状提取单测（证据分栏：UNIT/MOCK）。
 *
 * 验证重点：
 * 1. remoteFailureOf 精确覆盖 Host 的三种异构返回形状（handshake / saveAck / pause / leaseStatus）。
 * 2. runRemoteDiagnostics 独立探针流程与状态判定，尤其是 STALE_RUNTIME 旧代次拒绝必须显式要求。
 * 3. 错误信息脱敏与三态渲染（available: false 显示不可用，而不是没有模型）。
 *
 * 运行：node --test test/diagnostics.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteFailureOf } from '../src/bridge/remote-mount.js';
import { runRemoteDiagnostics, sanitizeMessage, DIAG_GAME_ID } from '../src/bridge/diagnostics.js';

test('remoteFailureOf 精准识别三种异构返回形状', () => {
  // 1. 成功情况
  assert.equal(remoteFailureOf({ ok: true, generation: 1 }), null);
  assert.equal(remoteFailureOf({ accepted: true, state: 'paused' }), null);
  assert.equal(remoteFailureOf({ absent: true }), null, 'leaseStatus 的 absent: true 不是错误');

  // 2. handshake 失败形状：{ ok: false, errorCode, message }
  const hsFail = remoteFailureOf({
    ok: false,
    errorCode: 'PROTOCOL_INVALID',
    message: 'bridgeVersion 不受支持。',
  });
  assert.deepEqual(hsFail, {
    code: 'PROTOCOL_INVALID',
    message: 'bridgeVersion 不受支持。',
  });

  // 3. saveAck / pause 失败形状：{ accepted: false, error: { code, message } }
  const saFail = remoteFailureOf({
    accepted: false,
    error: { code: 'STALE_RUNTIME', message: '没有与该代次对应的运行实例。' },
  });
  assert.deepEqual(saFail, {
    code: 'STALE_RUNTIME',
    message: '没有与该代次对应的运行实例。',
  });

  // 4. 字段缺省兜底
  assert.deepEqual(remoteFailureOf({ ok: false }), { code: 'UNKNOWN', message: 'gameCenter 调用失败' });
  assert.deepEqual(remoteFailureOf({ accepted: false }), { code: 'UNKNOWN', message: 'gameCenter 调用被拒绝' });
});

test('runRemoteDiagnostics: $mount 失败时直接终止并如实展示挂载错误码', async () => {
  const rows = await runRemoteDiagnostics({
    remoteState: { mounted: false, failure: 'MOUNT_THREW: timeout' },
    makeNonce: () => '1234567890abcdef',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.key, 'mount');
  assert.equal(rows[0]?.status, 'fail');
  assert.match(rows[0]?.value ?? '', /MOUNT_THREW/);
});

test('runRemoteDiagnostics: 全链路正常流程测试（带 runtimeToken 鉴权与固定 gameId）', async () => {
  const calls = [];
  const mockClient = {
    async handshake(input) {
      calls.push({ method: 'handshake', input });
      return { ok: true, generation: 1, state: 'running', runtimeToken: 'token-secret-123456' };
    },
    async modelCatalog() {
      calls.push({ method: 'modelCatalog' });
      return {
        available: true,
        entries: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
        failures: [],
      };
    },
    async leaseStatus(input) {
      calls.push({ method: 'leaseStatus', input });
      return { state: 'running', generation: 1, lastPersistedRevision: 0 };
    },
    async pause(input) {
      calls.push({ method: 'pause', input });
      return { accepted: true, state: 'pausing', timeoutMs: 3000 };
    },
    async saveAck(input) {
      calls.push({ method: 'saveAck', input });
      if (input.generation === 0) {
        const err = new Error('没有与该代次对应的运行实例。');
        // @ts-expect-error test mock
        err.code = 'STALE_RUNTIME';
        throw err;
      }
      return { accepted: true, state: 'paused', lastPersistedRevision: 1 };
    },
    async abandonRuntime(input) {
      calls.push({ method: 'abandonRuntime', input });
      return { ok: true, abandoned: true, reclaimed: false };
    },
  };

  const rows = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client: mockClient,
    makeNonce: () => 'abcdef1234567890',
  });

  // 验证共进行了 8 步检查（第 8 步为 2026-10-20 新增的 abandonRuntime）
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, ['mount', 'handshake', 'catalog', 'lease', 'pause', 'staleSave', 'saveAck', 'abandon']);

  // 所有探针状态均为 ok
  for (const row of rows) {
    assert.equal(row.status, 'ok', `行 ${row.key} 期望状态 ok，实际为 ${row.status}: ${row.value}`);
    // 关键安全验证：UI 显示值中严禁包含任何 token 原文
    assert.equal(row.value.includes('token-secret-123456'), false, 'UI 诊断文案不得泄漏 runtimeToken 原文');
  }

  // 验证固定 gameId 与参数贯通一致性
  const hsCall = calls.find((c) => c.method === 'handshake');
  const lsCall = calls.find((c) => c.method === 'leaseStatus');
  const pauseCall = calls.find((c) => c.method === 'pause');
  const saveCall = calls.find((c) => c.method === 'saveAck' && c.input.generation === 1);
  const staleSaveCall = calls.find((c) => c.method === 'saveAck' && c.input.generation === 0);

  assert.ok(hsCall && lsCall && pauseCall && saveCall && staleSaveCall);
  assert.equal(hsCall.input.gameId, DIAG_GAME_ID, '探针必须使用固定 DIAG_GAME_ID');
  assert.equal(lsCall.input.gameId, DIAG_GAME_ID);
  assert.equal(lsCall.input.saveId, hsCall.input.saveId, '依赖租约的探针必须与握手复用同一 saveId');
  assert.equal(hsCall.input.saveId, 'save-default', '存档槽位与运行身份分离：诊断链固定 save-default');
  assert.notEqual(
    hsCall.input.saveId,
    hsCall.input.runtimeInstanceId,
    'saveId 不得再等于 runtimeInstanceId（历史缺陷：续玩永远读不到检查点）',
  );
  // 协议必填：launchToken 必须在握手载荷里，且满足形状约束（>=32 位可见 ASCII）
  assert.ok(
    typeof hsCall.input.launchToken === 'string' && hsCall.input.launchToken.length >= 32,
    '握手必须携带合法形状的 launchToken',
  );
  // 诊断链末尾必须 abandonRuntime，且与握手用同一对身份值
  const abandonCall = calls.find((c) => c.method === 'abandonRuntime');
  assert.ok(abandonCall, '诊断链末尾必须调用 abandonRuntime');
  assert.equal(abandonCall.input.launchToken, hsCall.input.launchToken, 'abandonRuntime 必须用同一个 launchToken');
  assert.equal(
    abandonCall.input.runtimeInstanceId,
    hsCall.input.runtimeInstanceId,
    'abandonRuntime 必须用同一个 runtimeInstanceId',
  );

  // 验证所有鉴权调用均正确携带了 handshake 下发的 runtimeToken
  assert.equal(lsCall.input.runtimeToken, 'token-secret-123456');
  assert.equal(pauseCall.input.runtimeToken, 'token-secret-123456');
  assert.equal(saveCall.input.runtimeToken, 'token-secret-123456');
  assert.equal(staleSaveCall.input.runtimeToken, 'token-secret-123456');
});

test('runRemoteDiagnostics: 固定 gameId 下多轮运行依然保持隔离且 STALE_RUNTIME 稳定生效', async () => {
  const tokens = [];
  const runtimes = [];
  let round = 1;

  const mockClient = {
    async handshake(input) {
      assert.equal(input.gameId, DIAG_GAME_ID, '两轮均使用相同的固定 gameId');
      runtimes.push(input.runtimeInstanceId);
      const token = `token-round-${round++}`;
      tokens.push(token);
      return { ok: true, generation: 1, state: 'running', runtimeToken: token };
    },
    async modelCatalog() {
      return { available: true, entries: [], failures: [] };
    },
    async leaseStatus(input) {
      assert.ok(input.runtimeToken);
      return { state: 'running', generation: 1 };
    },
    async pause(input) {
      assert.ok(input.runtimeToken);
      return { accepted: true, state: 'pausing', timeoutMs: 3000 };
    },
    async saveAck(input) {
      assert.ok(input.runtimeToken);
      if (input.generation === 0) {
        const err = new Error('stale');
        // @ts-expect-error test mock
        err.code = 'STALE_RUNTIME';
        throw err;
      }
      return { accepted: true, state: 'paused' };
    },
  };

  const rows1 = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client: mockClient,
    makeNonce: () => 'nonce-first-round',
  });
  const rows2 = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client: mockClient,
    makeNonce: () => 'nonce-second-round',
  });

  assert.equal(rows1.find((r) => r.key === 'staleSave')?.status, 'ok');
  assert.equal(rows2.find((r) => r.key === 'staleSave')?.status, 'ok');

  // 验证两轮运行时凭证与实例 ID 独立
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.notEqual(runtimes[0], runtimes[1]);
});

test('runRemoteDiagnostics: modelCatalog 不可用时如实显示不可用状态（三态中的 warn）', async () => {
  const mockClient = {
    async handshake() {
      return { ok: true, generation: 1, state: 'running', runtimeToken: 'mock-token-cat' };
    },
    async modelCatalog() {
      return {
        available: false,
        entries: [],
        failures: [{ providerId: 'openai', error: 'API key not configured' }],
      };
    },
    async leaseStatus() {
      return { state: 'running', generation: 1 };
    },
    async pause() {
      return { accepted: true, state: 'pausing', timeoutMs: 3000 };
    },
    async saveAck(input) {
      if (input.generation === 0) {
        const err = new Error('stale');
        // @ts-expect-error test mock
        err.code = 'STALE_RUNTIME';
        throw err;
      }
      return { accepted: true, state: 'paused' };
    },
  };

  const rows = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client: mockClient,
    makeNonce: () => 'abcdef1234567890',
  });

  const catRow = rows.find((r) => r.key === 'catalog');
  assert.ok(catRow);
  assert.equal(catRow.status, 'warn');
  assert.match(catRow.value, /不可用/);
  assert.match(catRow.value, /API key not configured/);
});

test('runRemoteDiagnostics: 旧代次未被拒绝时必须判 fail', async () => {
  const mockClient = {
    async handshake() {
      return { ok: true, generation: 2, state: 'running', runtimeToken: 'mock-token-stale-fail' };
    },
    async modelCatalog() {
      return { available: true, entries: [], failures: [] };
    },
    async leaseStatus() {
      return { state: 'running', generation: 2 };
    },
    async pause() {
      return { accepted: true, state: 'pausing', timeoutMs: 3000 };
    },
    async saveAck() {
      // 模拟缺陷: 旧代次竟然返回 accepted: true
      return { accepted: true, state: 'running' };
    },
  };

  const rows = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client: mockClient,
    makeNonce: () => 'abcdef1234567890',
  });

  const staleRow = rows.find((r) => r.key === 'staleSave');
  assert.ok(staleRow);
  assert.equal(staleRow.status, 'fail', '旧代次未被拒绝必须标记为 fail');
  assert.match(staleRow.value, /异常: 旧代次未被拒绝/);
});

test('sanitizeMessage: 换行消除与安全截断', () => {
  const raw = 'line1\r\nline2\nline3 ' + 'a'.repeat(200);
  const sanitized = sanitizeMessage(raw, 50);
  assert.equal(sanitized.includes('\n'), false);
  assert.equal(sanitized.endsWith('…'), true);
  assert.ok(sanitized.length <= 51);
});

test('契约负例：握手响应缺少 generation 或 runtimeToken 必须判为 fail 且绝不伪装成功', async () => {
  // 模拟实机一度出现的缺陷：未解包信封或字段缺失，仅得到 { ok: true, generation: 0, state: 'running' } 无 token
  const mockClient = {
    async handshake() {
      return { ok: true, generation: 0, state: 'running' };
    },
    async modelCatalog() {
      return { available: true, entries: [], failures: [] };
    },
  };

  const rows = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client: mockClient,
    makeNonce: () => 'test-nonce-contract-fail',
  });

  const hsRow = rows.find((r) => r.key === 'handshake');
  assert.ok(hsRow);
  assert.equal(hsRow.status, 'fail', '缺少有效代次与凭证时严禁标为 ok');
  assert.match(hsRow.value, /契约异常/);

  // 后续步骤必须全部跳过，绝不发起
  const leaseRow = rows.find((r) => r.key === 'lease');
  assert.equal(leaseRow?.status, 'skip');
});

test('契约负例：modelCatalog 响应缺少 available 字段时必须判为 fail，绝不回落为假性的“服务未就绪”', async () => {
  const mockClient = {
    async handshake() {
      return { ok: true, generation: 1, runtimeToken: 'valid-token', state: 'running' };
    },
    async modelCatalog() {
      // 模拟返回未解包信封或残缺对象，缺少 available 字段
      return { failures: [] };
    },
    async leaseStatus() {
      return { state: 'running', generation: 1 };
    },
    async pause() {
      return { accepted: true, timeoutMs: 3000 };
    },
    async saveAck(input) {
      if (input.generation === 0) {
        const err = new Error('stale');
        // @ts-expect-error test mock
        err.code = 'STALE_RUNTIME';
        throw err;
      }
      return { accepted: true };
    },
  };

  const rows = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client: mockClient,
    makeNonce: () => 'test-nonce-cat-contract-fail',
  });

  const catRow = rows.find((r) => r.key === 'catalog');
  assert.ok(catRow);
  assert.equal(catRow.status, 'fail', '缺少 available 字段时必须判为 fail 契约异常');
  assert.match(catRow.value, /契约异常: 缺少 available 字段/);
  assert.equal(catRow.value.includes('服务未就绪'), false, '绝不得误报为服务未就绪');
});
