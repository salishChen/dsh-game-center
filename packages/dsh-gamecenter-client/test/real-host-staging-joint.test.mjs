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

/**
 * 乱序用例用的启动令牌（满足协议 `isLaunchTokenShapeValid`：32~256 位可见 ASCII、无空白）。
 * 固定字面量只为可复现；真实 UI 路径每次启动都重新生成。
 */
const LAUNCH_TOKEN_A = 'a'.repeat(43);
const LAUNCH_TOKEN_B = 'b'.repeat(43);

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

/**
 * 带可控时钟的 Host core：把 nowMs 交给测试推进，
 * 用于验证 `LEASE_ACK_WINDOW_MS` 有界回收，而不必真的等 3 秒。
 * @returns {{core: any, advance: (ms: number) => void}}
 */
function createControllableClockCore() {
  let now = 1_700_000_000_000;
  const core = new GameCenterCoreClass({
    createToken: () => crypto.randomBytes(32).toString('base64url'),
    digestToken: (token) => crypto.createHash('sha256').update(token).digest('hex'),
    nowMs: () => now,
    ttlMs: 60000,
  });
  return { core, advance: (ms) => { now += ms; } };
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
  assert.deepEqual(keys, ['mount', 'handshake', 'catalog', 'lease', 'pause', 'staleSave', 'saveAck', 'abandon']);

  for (const row of rows) {
    if (row.key === 'catalog') {
      // modelCatalog 在无真实 llm 注入时为 warn (available: false)，这是预期的三态之一
      assert.ok(row.status === 'ok' || row.status === 'warn');
    } else if (row.key === 'abandon') {
      // Host 尚未实现 abandonRuntime 时如实呈现 warn，不当成 UI 故障
      assert.ok(row.status === 'ok' || row.status === 'warn', `行 abandon 状态异常: ${row.value}`);
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
    // 2026-10-20 起 saveId 是握手必填（Host 不再回退 runtimeInstanceId）。
    saveId: 'save-default',
    // 2026-10-20 起 launchToken 同为必填（abandonRuntime 的身份依据）。
    launchToken: LAUNCH_TOKEN_A,
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

test('生命周期安全断言：迟到的握手不得留下无人持有的 running 租约（PM 阻断项，禁止降级断言）', async () => {
  // 用可控时钟：迟到握手接管后处于 pending，需要越过 LEASE_ACK_WINDOW_MS(3000ms)
  // 才会被 sweep 回收。真实等待 3 秒太慢，这里推进时钟来验证同一判据。
  const { core, advance } = createControllableClockCore();

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
  assert.equal(rows1.length, 2, '第一轮在 handshake等待中即被中断，仅记录了 mount 和 pending 握手，未发起后续 5 步调用');

  // 第二轮诊断立刻启动（相同的固定 DIAG_GAME_ID，无延迟）
  handshakeDelayMs = 0;
  const ctrl2 = new AbortController();
  const rows2 = await runRemoteDiagnostics({
    remoteState: { mounted: true, failure: null },
    client,
    makeNonce: () => 'nonce_round_2_def',
    signal: ctrl2.signal,
  });

  // 第二轮 8 项指标顺利全绿（第 8 项 abandon 在 Host 未实现时为 warn，属预期）
  const keys2 = rows2.map((r) => r.key);
  assert.deepEqual(keys2, ['mount', 'handshake', 'catalog', 'lease', 'pause', 'staleSave', 'saveAck', 'abandon']);
  const saveAckRow2 = rows2.find((r) => r.key === 'saveAck');
  assert.equal(saveAckRow2?.status, 'ok');

  // 等待第一轮在 Host 侧底层的延迟异步彻底结算
  await new Promise((r) => setTimeout(r, 120));
  // 迟到握手已接管槽位但未被确认 -> 推进时钟越过 LEASE_ACK_WINDOW_MS(3000ms)，
  // 触发 Host 的有界回收（sweepUnconfirmed），把槽位还原为接管前的已封存态。
  advance(3500);
  core.registry.sweepUnconfirmed(core.nowMs());

  const allLeases = core.registry.all();

  // 【安全断言 1 · PM 阻断项】全程结束后，registry 中不得存在 state=running 的租约。
  // 迟到的第一轮握手若在 Client 已 abort 之后仍取得新代次并 markRunning，
  // 就会留下一个系统里无人持有的孤儿 running 租约——这正是 PM 点名不得靠
  // "改断言为事实描述"绕过的生命周期漏洞。
  // 两种合法结果都接受：(a) 迟到握手被拒（不创建租约）；(b) 迟到握手被创建后
  // 在有界时间内被封存/停止，绝不停在 running。
  const orphanRunning = allLeases.filter((l) => l.state === 'running');
  assert.equal(
    orphanRunning.length,
    0,
    `迟到的握手不得留下无人持有的 running 租约（孤儿数量=${orphanRunning.length}，` +
      `详情=${JSON.stringify(orphanRunning.map((l) => ({ state: l.state, gen: l.generation, rt: l.runtimeInstanceId })))}）`,
  );

  // 下方断言在 Host 修掉"迟到握手接管已封存槽位"之前**必然失败**，
  // 这是 PM 点名的本地生命周期阻断，不是可以降级描述放过的既有语义。
  // 一旦 Host 采纳补偿/取消方案（abandonRuntime 或 T_ack 有界封存），
  // 这里会自然转绿；在那之前禁止把断言改成"描述现状"。
  assert.equal(allLeases.length, 1, '同一 saveId 单控制者：注册表只保留一条租约记录');
  const lease2 = allLeases[0];
  assert.equal(lease2.saveId, 'save-default', '接管后租约仍绑定固定存档槽位');
  assert.equal(
    lease2.state === 'paused' || lease2.state === 'stopped' || lease2.state === 'recovery-available',
    true,
    `第二轮正常结束的租约必须处于已封存状态，实际 state=${lease2.state}`,
  );

  // 【安全断言 3】第二轮封存后的凭证不得再写入（历史 N7e 缺陷回归防线）。
  // 迟到接管会把第二轮凭证 supersede，这里断言该凭证已从 byToken 解析不到。
  assert.equal(
    core.registry.byToken.has(lease2.tokenDigest),
    lease2.state === 'running',
    '当前槽位凭证必须与当前租约状态一致：封存/停止后不得仍可由凭证解析',
  );

  // 【安全断言 4 · 快速关闭重开】A 完成 pause+saveAck 后，B 立即握手成功、读回 revision、继续写入成功。
  const reopen = await client.handshake({
    runtimeInstanceId: 'rt-reopen-C',
    nonce: 'nonce_reopen_C',
    gameId: DIAG_GAME_ID,
    gameVersion: '0.0.0',
    sdkVersion: '0.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'c'.repeat(43),
  });
  assert.equal(reopen.ok, true, '正常关闭保存后重开必须握手成功');
  assert.ok(typeof reopen.generation === 'number' && reopen.generation > lease2.generation, '重开必须是更高代次接管');
  assert.ok(typeof reopen.runtimeToken === 'string' && reopen.runtimeToken.length > 0, '重开必须拿到新的运行凭证');
  // 重开后必须主动确认一次，让 Host 把 pending 推进为 running（协议 T_ack 语义）
  const confirm = await client.leaseStatus({
    runtimeToken: reopen.runtimeToken,
    gameId: DIAG_GAME_ID,
    saveId: 'save-default',
  });
  assert.equal(confirm.absent, undefined, '重开后租约必须可查询（不得 absent）');
  const status = await client.leaseStatus({
    runtimeToken: reopen.runtimeToken,
    gameId: DIAG_GAME_ID,
    saveId: 'save-default',
  });
  assert.equal(status.state, 'running', '确认后重开租约应为 running');
  // 重开后先写一个检查点（saveCheckpoint）再暂停确认，模拟真实"继续玩一会儿再关闭"
  await client.pause({ runtimeToken: reopen.runtimeToken, generation: reopen.generation, reason: 'close' });
  const reopenAck = await client.saveAck({ runtimeToken: reopen.runtimeToken, revision: 2, generation: reopen.generation });
  assert.equal(reopenAck.accepted, true, '重开后必须能继续写入（revision 递增）');

  // 收尾：重开实例已暂停封存，最终不得留下 running 租约
  const finalLeases = core.registry.all();
  assert.equal(
    finalLeases.filter((l) => l.state === 'running').length,
    0,
    '用例结束时不得留下任何 running 租约',
  );
});

test('握手失败/取消：伪造与过期握手请求不得创建租约、不得推进代次', async () => {
  const core = createRealHostStagingCore();
  const client = createGameCenterClient(core);

  const before = core.registry.all().length;

  // 1. 缺少 saveId（协议必填）-> PROTOCOL_INVALID，且不得创建租约
  await assert.rejects(
    () =>
      client.handshake({
        runtimeInstanceId: 'rt-nosave',
        nonce: 'n1',
        gameId: DIAG_GAME_ID,
        gameVersion: '0.0.0',
        sdkVersion: '0.0.0',
        bridgeVersion: 1,
      }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'PROTOCOL_INVALID');
      return true;
    },
  );

  // 2. 非法形状的 saveId（含路径分隔符）-> PROTOCOL_INVALID，且不得创建租约
  await assert.rejects(
    () =>
      client.handshake({
        runtimeInstanceId: 'rt-badsave',
        nonce: 'n2',
        gameId: DIAG_GAME_ID,
        gameVersion: '0.0.0',
        sdkVersion: '0.0.0',
        bridgeVersion: 1,
        saveId: '../evil/save',
      }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'PROTOCOL_INVALID');
      return true;
    },
  );

  // 3. 不支持的 bridgeVersion -> PROTOCOL_INVALID，且不得创建租约
  await assert.rejects(
    () =>
      client.handshake({
        runtimeInstanceId: 'rt-badver',
        nonce: 'n3',
        gameId: DIAG_GAME_ID,
        gameVersion: '0.0.0',
        sdkVersion: '0.0.0',
        bridgeVersion: 2,
        saveId: 'save-default',
      }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'PROTOCOL_INVALID');
      return true;
    },
  );

  const after = core.registry.all();
  assert.equal(after.length, before, '三次失败握手都不得创建任何租约');
  assert.equal(core.registry.byToken.size, 0, '失败握手不得登记任何凭证摘要');
  assert.equal(core.registry.supersededTokens.size, 0, '失败握手不得推进/取代任何代次');
});

/**
 * 乱序四类用例（协议 2026-10-20 冻结 `abandonRuntime` + `launchToken` 后的回归防线）。
 *
 * 这些用例断言的是**协议要求的最终状态**，不是当前 Host 实现。
 * Host 侧未实现 `abandonRuntime` 时它们必然失败——这是预期的闸门，
 * 禁止为了让它们变绿而放宽断言或改成"描述现状"。
 */

test('乱序 1/4：放弃先到 —— abandonRuntime 后迟到的握手必须被拒且不留下 running', async () => {
  const core = createRealHostStagingCore();

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

  // A 的握手在途（延迟 60ms），Client 侧 15ms 后放弃并立即 abandonRuntime
  handshakeDelayMs = 60;
  const lateA = client.handshake({
    runtimeInstanceId: 'rt-order-A',
    nonce: 'nonce_order_A',
    gameId: DIAG_GAME_ID,
    gameVersion: '0.0.0',
    sdkVersion: '0.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: LAUNCH_TOKEN_A,
  }).then((v) => ({ settled: 'ok', generation: v.generation }), (e) => ({ settled: 'rejected', code: e?.code }));
  await new Promise((r) => setTimeout(r, 15));
  const abandonA = await client.abandonRuntime({ launchToken: LAUNCH_TOKEN_A, runtimeInstanceId: 'rt-order-A' });
  assert.equal(abandonA.ok, true, 'abandonRuntime 必须成功');
  assert.equal(abandonA.abandoned, true, 'abandonRuntime 必须报告 abandoned');

  await new Promise((r) => setTimeout(r, 100));
  const lateResult = await lateA;
  assert.equal(
    lateResult.settled,
    'rejected',
    `放弃先到时，迟到的握手必须被拒绝，实际 ${JSON.stringify(lateResult)}`,
  );

  const leases = core.registry.all();
  assert.equal(leases.length, 0, '放弃先到后不得残留任何租约');
  assert.equal(
    leases.filter((l) => l.state === 'running').length,
    0,
    '放弃先到后不得留下 running 租约',
  );
});

test('乱序 2/4：握手先到 —— 迟到握手先于 abandonRuntime 到达时同样不得留下孤儿 running', async () => {
  const core = createRealHostStagingCore();
  const client = createGameCenterClient(core);

  // A 的握手立即成功（无延迟），随后 A 才 abandon
  const hsA = await client.handshake({
    runtimeInstanceId: 'rt-order-A2',
    nonce: 'nonce_order_A2',
    gameId: DIAG_GAME_ID,
    gameVersion: '0.0.0',
    sdkVersion: '0.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: LAUNCH_TOKEN_A,
  });
  assert.equal(hsA.ok, true);

  const abandonA = await client.abandonRuntime({ launchToken: LAUNCH_TOKEN_A, runtimeInstanceId: 'rt-order-A2' });
  assert.equal(abandonA.ok, true, '握手先到时 abandonRuntime 同样必须成功');

  const leases = core.registry.all();
  assert.equal(
    leases.filter((l) => l.state === 'running').length,
    0,
    '握手先到 + abandon 后不得留下孤儿 running 租约',
  );

  // 被放弃实例的凭证不得再写入（旧令牌不得复活）
  const writeAfterAbandon = await client.saveAck({
    runtimeToken: hsA.runtimeToken,
    revision: 1,
    generation: hsA.generation,
  }).then((v) => ({ ok: true, accepted: v.accepted }), (e) => ({ ok: false, code: e?.code }));
  assert.equal(writeAfterAbandon.ok, false, '被放弃实例的凭证不得再写入');
  assert.equal(writeAfterAbandon.code, 'STALE_RUNTIME', '被放弃实例的凭证写入必须为 STALE_RUNTIME');
});

test('乱序 3/4：迟到握手在第二局封存后到达 —— 必须被拒且槽位停在已封存态', async () => {
  const core = createRealHostStagingCore();

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

  // A 延迟握手在途，15ms 后 Client 放弃
  handshakeDelayMs = 60;
  const lateA = client.handshake({
    runtimeInstanceId: 'rt-order-A3',
    nonce: 'nonce_order_A3',
    gameId: DIAG_GAME_ID,
    gameVersion: '0.0.0',
    sdkVersion: '0.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: LAUNCH_TOKEN_A,
  }).then((v) => ({ settled: 'ok', generation: v.generation }), (e) => ({ settled: 'rejected', code: e?.code }));
  await new Promise((r) => setTimeout(r, 15));

  // B 立即握手 + pause + saveAck，槽位正常封存
  handshakeDelayMs = 0;
  const hsB = await client.handshake({
    runtimeInstanceId: 'rt-order-B',
    nonce: 'nonce_order_B',
    gameId: DIAG_GAME_ID,
    gameVersion: '0.0.0',
    sdkVersion: '0.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: LAUNCH_TOKEN_B,
  });
  assert.equal(hsB.ok, true, '第二局必须握手成功');
  await client.pause({ runtimeToken: hsB.runtimeToken, generation: hsB.generation, reason: 'close' });
  await client.saveAck({ runtimeToken: hsB.runtimeToken, revision: 1, generation: hsB.generation });

  // 等 A 的迟到握手落地
  await new Promise((r) => setTimeout(r, 100));
  const lateResult = await lateA;

  const leases = core.registry.all();
  // 迟到握手要么被拒，要么被有界回收；绝不得把槽位留在无主 running
  assert.equal(
    leases.filter((l) => l.state === 'running').length,
    0,
    `迟到握手在第二局封存后到达，不得留下孤儿 running（迟到结果=${JSON.stringify(lateResult)}）`,
  );
  // B 已封存的凭证不得再写入
  const bWrite = await client.saveAck({
    runtimeToken: hsB.runtimeToken,
    revision: 2,
    generation: hsB.generation,
  }).then((v) => ({ ok: true, accepted: v.accepted }), (e) => ({ ok: false, code: e?.code }));
  assert.equal(bWrite.ok, false, '第二局封存后的凭证不得再写入');
  assert.equal(bWrite.code, 'STALE_RUNTIME', '第二局封存后的凭证写入必须为 STALE_RUNTIME');
});

test('乱序 4/4：重复取消 —— abandonRuntime 重复调用必须幂等且不抛错', async () => {
  const core = createRealHostStagingCore();
  const client = createGameCenterClient(core);

  const hs = await client.handshake({
    runtimeInstanceId: 'rt-order-idem',
    nonce: 'nonce_order_idem',
    gameId: DIAG_GAME_ID,
    gameVersion: '0.0.0',
    sdkVersion: '0.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: LAUNCH_TOKEN_A,
  });
  assert.equal(hs.ok, true);

  const first = await client.abandonRuntime({ launchToken: LAUNCH_TOKEN_A, runtimeInstanceId: 'rt-order-idem' });
  assert.equal(first.ok, true, '首次 abandonRuntime 必须成功');

  // 第二次：必须同样成功且不得抛错（Host 侧幂等）
  const second = await client.abandonRuntime({ launchToken: LAUNCH_TOKEN_A, runtimeInstanceId: 'rt-order-idem' });
  assert.equal(second.ok, true, '重复 abandonRuntime 必须幂等成功');
  assert.equal(second.abandoned, true, '重复 abandonRuntime 必须仍报告 abandoned');

  // 第三次：拿**已存在租约的**别人的 runtimeInstanceId 配同一令牌 -> 必须拒绝（交叉校验）。
  // 注意 Host 语义：若该 runtimeInstanceId 从未握手过，abandonRuntime 会走"毒丸"分支
  // 返回 ok（那是为了挡住"放弃先到、迟到握手后到"的乱序），所以必须用一个真实租约的
  // runtimeInstanceId 才能验到 ABANDON_FORBIDDEN。
  const hsOther = await client.handshake({
    runtimeInstanceId: 'rt-order-other',
    nonce: 'nonce_order_other',
    gameId: DIAG_GAME_ID,
    gameVersion: '0.0.0',
    sdkVersion: '0.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: LAUNCH_TOKEN_B,
  });
  assert.equal(hsOther.ok, true);
  await assert.rejects(
    () => client.abandonRuntime({ launchToken: LAUNCH_TOKEN_A, runtimeInstanceId: 'rt-order-other' }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'ABANDON_FORBIDDEN');
      return true;
    },
  );
  // 交叉校验失败不得顺手回收别人的实例：other 必须仍是未确认/运行态（不得被封存或消失）
  const otherLease = core.registry.all().find((l) => l.runtimeInstanceId === 'rt-order-other');
  assert.ok(otherLease, '交叉校验失败不得删除他人租约');
  assert.equal(
    otherLease.state === 'pending' || otherLease.state === 'running',
    true,
    `交叉校验失败不得影响他人实例，实际 state=${otherLease.state}`,
  );
  assert.equal(otherLease.sealed, false, '交叉校验失败不得封存他人实例');

  // 用正确的令牌取消 other，收尾不得留下 running
  const third = await client.abandonRuntime({ launchToken: LAUNCH_TOKEN_B, runtimeInstanceId: 'rt-order-other' });
  assert.equal(third.ok, true, '正确令牌的 abandonRuntime 必须成功');

  const leases = core.registry.all();
  assert.equal(
    leases.filter((l) => l.state === 'running').length,
    0,
    '重复取消结束后不得留下 running 租约',
  );
});

