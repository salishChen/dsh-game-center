// @ts-check
/**
 * 真实 Host Staging 服务与 Client 诊断逻辑的端到端联合测试（证据分栏：UNIT/MOCK/INTEGRATION，非 DSH-REAL）。
 *
 * 验证重点：
 * 1. 真实引用 packages/dsh-gamecenter/staging/remote/game-center-service.js 中的 GameCenterCore。
 * 2. 验证 Client createGameCenterClient 包装层能无缝对接真实 Host 产物。
 * 3. 固定 DIAG_GAME_ID 连续多轮运行，验证 runtimeToken 定位机制消除了跨轮代次串扰。
 * 4. 验证凭证安全与防篡改：伪造 runtimeToken 或跨 saveId 声明必须严格返回 PROTOCOL_INVALID。
 * 5. 验证旧代次迟到写入严格返回 STALE_RUNTIME。
 *
 * 运行：node --test test/real-host-staging-joint.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGameCenterClient } from '../src/bridge/remote-mount.js';
import { runRemoteDiagnostics, DIAG_GAME_ID } from '../src/bridge/diagnostics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostStagingServiceUrl = pathToFileURL(
  path.resolve(here, '../../dsh-gamecenter/staging/remote/game-center-service.js'),
).href;

/** @type {any} */
let GameCenterCoreClass;

test('加载真实 Host Staging 服务产物', async () => {
  const mod = await import(hostStagingServiceUrl);
  assert.ok(mod.GameCenterCore, 'Host staging 必须导出 GameCenterCore');
  GameCenterCoreClass = mod.GameCenterCore;
});

function createRealHostStagingCore() {
  return new GameCenterCoreClass({
    createToken: () => crypto.randomBytes(32).toString('base64url'),
    digestToken: (token) => crypto.createHash('sha256').update(token).digest('hex'),
    nowMs: () => Date.now(),
    ttlMs: 60000,
  });
}

test('真实 Host Staging + Client 逻辑：单轮诊断全链路 7 项指标全绿', async () => {
  const core = createRealHostStagingCore();
  const client = createGameCenterClient(core);

  const rows = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client,
    makeNonce: () => crypto.randomUUID().replace(/-/g, ''),
  });

  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, ['mount', 'handshake', 'catalog', 'lease', 'pause', 'staleSave', 'saveAck']);

  for (const row of rows) {
    if (row.key === 'catalog') {
      // modelCatalog 在无真实 llm 注入时为 warn (available: false)，这是预期的三态之一
      assert.ok(row.status === 'ok' || row.status === 'warn');
    } else {
      assert.equal(row.status, 'ok', `行 ${row.key} 期望状态 ok，实际为 ${row.status}: ${row.value}`);
    }
  }

  const staleRow = rows.find((r) => r.key === 'staleSave');
  assert.ok(staleRow);
  assert.equal(staleRow.status, 'ok');
  assert.match(staleRow.value, /STALE_RUNTIME/);
});

test('真实 Host Staging + Client 逻辑：固定 DIAG_GAME_ID 连续两轮运行均稳定获得 STALE_RUNTIME', async () => {
  const core = createRealHostStagingCore();
  const client = createGameCenterClient(core);

  // 第一轮运行
  const rows1 = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client,
    makeNonce: () => crypto.randomUUID().replace(/-/g, ''),
  });
  // 紧接着在同一 Host 实例中进行第二轮运行（使用相同固定 gameId）
  const rows2 = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client,
    makeNonce: () => crypto.randomUUID().replace(/-/g, ''),
  });

  const stale1 = rows1.find((r) => r.key === 'staleSave');
  const stale2 = rows2.find((r) => r.key === 'staleSave');
  assert.ok(stale1 && stale2);

  // 第二轮绝不会退化成 PROTOCOL_INVALID，必须稳定通过 STALE_RUNTIME
  assert.equal(stale1.status, 'ok', `第一轮旧代次校验期望 ok: ${stale1.value}`);
  assert.equal(stale2.status, 'ok', `第二轮旧代次校验期望 ok: ${stale2.value}`);
});

test('安全负例：凭据伪造与跨 saveId 窜改必须被真实 Host Staging 拒绝为 PROTOCOL_INVALID', async () => {
  const core = createRealHostStagingCore();
  const client = createGameCenterClient(core);

  // 1. 握手获取合法租约与凭证
  const hs = await client.handshake({
    runtimeInstanceId: 'rt-legit-01',
    nonce: 'nonce01',
    gameId: DIAG_GAME_ID,
    gameVersion: '0.0.0',
    sdkVersion: '0.0.0',
    bridgeVersion: 1,
  });
  assert.ok(hs.runtimeToken);

  // 2. 伪造 token 请求 saveAck -> 必须被拒绝并转成 PROTOCOL_INVALID 异常
  await assert.rejects(
    () => client.saveAck({ runtimeToken: 'forged-fake-token', revision: 1 }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'PROTOCOL_INVALID');
      return true;
    },
  );

  // 3. 跨 saveId 声明窜改：出示合法 token，但声明的 saveId 是他人存档 -> 必须严格拒绝为 PROTOCOL_INVALID
  await assert.rejects(
    () => client.saveAck({ runtimeToken: hs.runtimeToken, revision: 1, saveId: 'hacked-victim-save' }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'PROTOCOL_INVALID');
      assert.match(/** @type {any} */ (err).message, /声明的 saveId 与运行凭证不符/);
      return true;
    },
  );
});

test('生命周期与副作用负例：真实 Host 延迟握手 → 旧轮 abort → 新轮完成 → 观察代次隔离与租约残留', async () => {
  const core = createRealHostStagingCore();

  // 模拟 Host 端在底层处理 handshake 时存在 60ms 的网络/处理延迟
  let handshakeDelayMs = 0;
  const delayedCore = new Proxy(core, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (prop === 'handshake' && typeof orig === 'function') {
        return async function (...args) {
          if (handshakeDelayMs > 0) {
            await new Promise((r) => setTimeout(r, handshakeDelayMs));
          }
          return orig.apply(target, args);
        };
      }
      return orig;
    },
  });

  const client = createGameCenterClient(delayedCore);

  // 第一轮诊断：开启 60ms 延迟
  handshakeDelayMs = 60;
  const ctrl1 = new AbortController();
  const run1Promise = runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client,
    makeNonce: () => 'nonce_round_1_abc',
    signal: ctrl1.signal,
  });

  // 在 15ms 时，用户点击重试或关闭弹层触发 abort
  await new Promise((r) => setTimeout(r, 15));
  ctrl1.abort();

  // 第一轮由于 signal.aborted，Client 侧在握手等待中被中止，记录了 mount 与 handshake(pending)，未发起后续步骤
  const rows1 = await run1Promise;
  assert.ok(ctrl1.signal.aborted, '第一轮必须已标记为 aborted');
  assert.equal(rows1.length, 2, '第一轮在 handshake 等待中即被中断，仅记录了 mount 和 pending 握手，未发起后续 5 步调用');


  // 第二轮诊断立刻启动（相同的固定 DIAG_GAME_ID，无延迟）
  handshakeDelayMs = 0;
  const ctrl2 = new AbortController();
  const rows2 = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client,
    makeNonce: () => 'nonce_round_2_def',
    signal: ctrl2.signal,
  });

  // 第二轮 7 项指标顺利全绿
  const keys2 = rows2.map((r) => r.key);
  assert.deepEqual(keys2, ['mount', 'handshake', 'catalog', 'lease', 'pause', 'staleSave', 'saveAck']);
  const saveAckRow2 = rows2.find((r) => r.key === 'saveAck');
  assert.equal(saveAckRow2?.status, 'ok');

  // 等待第一轮在 Host 侧底层的延迟异步彻底结算
  await new Promise((r) => setTimeout(r, 80));

  // 深入核查真实 Host 的租约注册表状态（副作用隔离与最大残留证据）
  const allLeases = core.registry.all();
  // 应当存在 2 个租约记录：round 1 和 round 2
  const lease1 = allLeases.find((l) => l.runtimeInstanceId.startsWith('diag-nonce_round_1'));
  const lease2 = allLeases.find((l) => l.runtimeInstanceId.startsWith('diag-nonce_round_2'));

  assert.ok(lease2, '第二轮租约必须存在');
  assert.equal(lease2.state, 'paused', '第二轮租约必须正常完成 pause/saveAck 并处于 paused 封存态');

  assert.ok(lease1, '第一轮由于底层 RPC 已经投递，Host 依然完成了握手创建了租约记录（不可被传输层强行撤销）');
  assert.equal(lease1.state, 'running', '第一轮被本地 abort 后，Client 严禁发起后续 pause，故第一轮在 Host 处于 running 残留态');

  // 核心安全断言：第一轮与第二轮严格隔离，第一轮迟到完成绝不污染第二轮的凭证、代次与数据
  assert.notEqual(lease1.tokenDigest, lease2.tokenDigest, '两轮租约具有完全独立的运行凭证');
  assert.notEqual(lease1.generation, lease2.generation, '两轮租约被赋予互不冲突的独立代次');
  assert.equal(core.registry.byToken.get(lease2.tokenDigest), `${DIAG_GAME_ID}\x00${lease2.saveId}`, '第二轮的凭证精准绑定其独立 saveId');
  assert.equal(core.registry.byToken.get(lease1.tokenDigest), `${DIAG_GAME_ID}\x00${lease1.saveId}`, '第一轮的凭证精准绑定其独立 saveId');

  // 最大残留证明：残留仅限于单个 running 状态的孤儿 LeaseRecord，待 ttlMs (此处 60s) 后由 Host sweeper 自动回收
});

