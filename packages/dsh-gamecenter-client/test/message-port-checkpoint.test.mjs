// @ts-check
/**
 * 真实 MessagePort 通信驱动存档检查点与关闭恢复测试（证据分栏：UNIT/MOCK/INTEGRATION）。
 *
 * 验证重点（对应阶段1 P6 端到端闭环）：
 * 1. 真实 Node.js MessageChannel 双向驱动：
 *    SDK.save.checkpoint -> port1 -> port2 -> BridgeDispatcher -> Host staging SaveStore + SQLite -> 回执。
 * 2. 幂等去重与多动作单调性（"重试同 op，不同动作同状态不同 op"）：
 *    - 相同 operationId 重试命中 SQLite 事务幂等去重，不增加 revision；
 *    - 相同 state 的新动作生成单调唯一 operationId，正确自增 revision。
 * 3. 缺字段严格错误防御：
 *    - 缺少 playerId、缺少 operationId、非法 expectedRevision 时由 BridgeDispatcher 严格返回 PROTOCOL_INVALID。
 * 4. 真实扫雷游戏状态存取与关闭恢复一致性：
 *    - 驱动扫雷引擎产生状态，经 MessageChannel 存入真实 SQLite 文件；
 *    - 暂停流程中回传 pauseAck，释放并关闭端口；
 *    - 从 SQLite 重建 SDK 与游戏引擎，验证棋盘、虚拟时钟与 RNG 状态 100% 一致。
 * 5. 端口与资源释放：
 *    - 所有端口/监听器/计时器在 finally 释放，无内存泄漏与进程悬挂，自然退出码 0。
 *
 * 运行：node --test test/message-port-checkpoint.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRuntimeLease } from '../src/runtime/lease.js';
import { createBridgeDispatcher, connectSDKToDispatcher } from '../src/bridge/dispatcher.js';
import { createGameCenterSDK } from '../src/sdk/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const hostStagingStoreUrl = pathToFileURL(
  path.resolve(here, '../../dsh-gamecenter/staging/storage/save-store.js'),
).href;
const hostStagingSqliteUrl = pathToFileURL(
  path.resolve(here, '../../dsh-gamecenter/staging/storage/sqlite-save-backend.js'),
).href;

/** @type {any} */
let SaveStoreClass;
/** @type {any} */
let SqliteSaveBackendClass;

async function loadHostStorage() {
  if (!SaveStoreClass) {
    const storeMod = await import(hostStagingStoreUrl);
    SaveStoreClass = storeMod.SaveStore;
    const sqliteMod = await import(hostStagingSqliteUrl);
    SqliteSaveBackendClass = sqliteMod.SqliteSaveBackend;
  }
  return { SaveStore: SaveStoreClass, SqliteSaveBackend: SqliteSaveBackendClass };
}

function resolveGameRepo() {
  const fromEnv = process.env.DSH_MINESWEEPING_REPO;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.resolve(repoRoot, '..', 'dsh-game-minesweeping');
}

async function loadMinesweeperEngine() {
  const enginePath = path.join(resolveGameRepo(), 'src', 'engine.js');
  const mod = await import(pathToFileURL(enginePath).href);
  return mod.MinesweeperEngine;
}

test('MessagePort 全链路驱动：SDK.save.checkpoint -> BridgeDispatcher -> Host staging SQLite 存储', async () => {
  const { SaveStore, SqliteSaveBackend } = await loadHostStorage();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-client-port-save-'));
  const dbPath = path.join(tmpDir, 'saves.db');

  const backend = new SqliteSaveBackend({ dbPath });
  const store = new SaveStore(backend);

  const lease = createRuntimeLease({
    gameId: 'example.minesweeping',
    saveId: 'save-e2e-01',
    runtimeInstanceId: 'rt-inst-1',
    nonce: 'nonce-e2e-1',
    generation: 1,
  });
  lease.state = 'running';
  lease.portBound = true;

  const link = connectSDKToDispatcher({
    lease,
    playerId: 'player-test-01',
    onCheckpoint: (input) => store.writeCheckpoint(input),
  });

  try {
    const res = await link.sdk.save.checkpoint({ turn: 1, board: [[0, 1], [1, 0]] });

    assert.equal(res.revision, 1, '首次保存成功后 revision 必须为 1');
    assert.equal(res.idempotentReplay, false, '新写入不应标记为幂等重放');
    assert.ok(typeof res.operationId === 'string' && res.operationId.startsWith('act-'), '返回合法的 operationId');

    // 直接从 Host SQLite 端读出存档验证数据完整落地
    const read = await store.readCheckpoint('example.minesweeping', 'save-e2e-01', {
      playerId: 'player-test-01',
      currentSaveFormatVersion: 1,
      supportedGameStateVersions: [1],
      installedCommits: ['current'],
    });

    assert.equal(read.ok, true, '读取已存检查点必须成功');
    assert.equal(read.save.revision, 1);
    assert.deepEqual(read.save.state, { turn: 1, board: [[0, 1], [1, 0]] });
    assert.equal(read.save.gameId, 'example.minesweeping');
    assert.equal(read.save.saveId, 'save-e2e-01');
  } finally {
    link.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('“重试同 op，不同动作同状态不同 op”幂等与单调性判定验证', async () => {
  const { SaveStore, SqliteSaveBackend } = await loadHostStorage();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-client-retry-'));
  const dbPath = path.join(tmpDir, 'saves.db');

  const backend = new SqliteSaveBackend({ dbPath });
  const store = new SaveStore(backend);

  const lease = createRuntimeLease({
    gameId: 'example.minesweeping',
    saveId: 'save-retry-01',
    runtimeInstanceId: 'rt-inst-2',
    nonce: 'nonce-retry-1',
    generation: 1,
  });
  lease.state = 'running';
  lease.portBound = true;

  const link = connectSDKToDispatcher({
    lease,
    playerId: 'player-test-01',
    onCheckpoint: (input) => store.writeCheckpoint(input),
  });

  try {
    const staticBoardState = { flags: ['2,2'], moves: 3 };

    // 1. 动作 1：首次写入，生成 op1
    const res1 = await link.sdk.save.checkpoint(staticBoardState);
    assert.equal(res1.revision, 1);
    assert.equal(res1.idempotentReplay, false);
    const op1 = res1.operationId;

    // 2. 模拟重试动作 1：指定 retry: true，复用 op1
    const resRetry = await link.sdk.save.checkpoint(staticBoardState, { retry: true });
    assert.equal(resRetry.operationId, op1, '重试时必须复用相同的 operationId');
    assert.equal(resRetry.revision, 1, '幂等重试不得自增 revision');
    assert.equal(resRetry.idempotentReplay, true, '同 op 同内容重试必须命中幂等重放');

    // 3. 动作 2：状态完全相同（例如标记后又取消标记回同一棋盘），但作为新动作调用
    const res2 = await link.sdk.save.checkpoint(staticBoardState);
    assert.notEqual(res2.operationId, op1, '不同动作即使状态相同，也必须生成不同 operationId');
    assert.equal(res2.revision, 2, '新动作必须推进 revision');
    assert.equal(res2.idempotentReplay, false, '新动作不能被误判为幂等重放');

    // 4. 显式指定 operationId 重试：游戏层自行控制
    const explicitState = { custom: 'game-data' };
    const resExplicit1 = await link.sdk.save.checkpoint(explicitState, { operationId: 'custom-op-88' });
    assert.equal(resExplicit1.revision, 3);
    assert.equal(resExplicit1.operationId, 'custom-op-88');

    const resExplicitRetry = await link.sdk.save.checkpoint(explicitState, { operationId: 'custom-op-88' });
    assert.equal(resExplicitRetry.revision, 3);
    assert.equal(resExplicitRetry.idempotentReplay, true, '显式指定相同 operationId 必须命中幂等去重');
  } finally {
    link.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('缺字段错误防御：缺少可信 playerId、缺少 operationId 或非法 expectedRevision 严格拒绝', async () => {
  const { SaveStore, SqliteSaveBackend } = await loadHostStorage();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-client-missing-'));
  const dbPath = path.join(tmpDir, 'saves.db');
  const store = new SaveStore(new SqliteSaveBackend({ dbPath }));

  const lease = createRuntimeLease({
    gameId: 'example.minesweeping',
    saveId: 'save-missing-01',
    runtimeInstanceId: 'rt-inst-3',
    nonce: 'nonce-missing-1',
    generation: 1,
  });
  lease.state = 'running';
  lease.portBound = true;

  // 1. 宿主未绑定 playerId
  const linkNoPlayer = connectSDKToDispatcher({
    lease,
    playerId: '', // 空身份
    onCheckpoint: (input) => store.writeCheckpoint(input),
  });

  await assert.rejects(
    () => linkNoPlayer.sdk.save.checkpoint({ score: 10 }),
    (err) => {
      const e = /** @type {any} */ (err);
      assert.equal(e.code, 'PROTOCOL_INVALID');
      assert.match(e.message, /宿主未绑定可信 playerId/);
      return true;
    },
  );
  linkNoPlayer.dispose();

  // 2. 正常链接：通过原生 port 发送缺失 operationId 的畸形报文
  const linkValid = connectSDKToDispatcher({
    lease,
    playerId: 'player-test-01',
    onCheckpoint: (input) => store.writeCheckpoint(input),
  });

  /**
   * @param {any} port
   * @param {any} message
   */
  function sendRawMessage(port, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sendRawMessage timeout')), 2000);
      const handler = (/** @type {any} */ event) => {
        const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
        if (data && data.requestId === message.requestId) {
          clearTimeout(timer);
          if (typeof port.removeEventListener === 'function') {
            port.removeEventListener('message', handler);
          }
          resolve(data);
        }
      };
      port.addEventListener('message', handler);
      port.postMessage(message);
    });
  }

  const responseMissingOp = await sendRawMessage(linkValid.port1, {
    bridgeVersion: 1,
    requestId: 'raw-req-no-op',
    method: 'save.checkpoint',
    payload: { expectedRevision: 0, state: {} }, // 缺少 operationId
  });

  assert.equal(responseMissingOp.ok, false);
  assert.equal(responseMissingOp.error.code, 'PROTOCOL_INVALID');
  assert.match(responseMissingOp.error.message, /必须提供 operationId/);

  // 3. 非法 expectedRevision
  const responseBadRev = await sendRawMessage(linkValid.port1, {
    bridgeVersion: 1,
    requestId: 'raw-req-bad-rev',
    method: 'save.checkpoint',
    payload: { operationId: 'valid-op', expectedRevision: -99, state: {} },
  });

  assert.equal(responseBadRev.ok, false);
  assert.equal(responseBadRev.error.code, 'PROTOCOL_INVALID');
  assert.match(responseBadRev.error.message, /expectedRevision 必须为非负整数/);

  linkValid.dispose();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('版本冲突与 STALE_RUNTIME 恢复测试', async () => {
  const { SaveStore, SqliteSaveBackend } = await loadHostStorage();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-client-stale-'));
  const dbPath = path.join(tmpDir, 'saves.db');
  const store = new SaveStore(new SqliteSaveBackend({ dbPath }));

  // 先在库内写入一条 revision: 1
  await store.writeCheckpoint({
    playerId: 'player-test-01',
    gameId: 'example.minesweeping',
    saveId: 'save-stale-01',
    operationId: 'initial-op',
    expectedRevision: 0,
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'current',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 0,
    rngState: '',
    modelBindings: {},
    state: { init: true },
  });

  const lease = createRuntimeLease({
    gameId: 'example.minesweeping',
    saveId: 'save-stale-01',
    runtimeInstanceId: 'rt-inst-4',
    nonce: 'nonce-stale-1',
    generation: 1,
  });
  lease.state = 'running';
  lease.portBound = true;

  const link = connectSDKToDispatcher({
    lease,
    playerId: 'player-test-01',
    onCheckpoint: (input) => store.writeCheckpoint(input),
  });

  try {
    // 客户端若传错 expectedRevision（例如传 0，而库内已是 1）
    await assert.rejects(
      () => link.sdk.save.checkpoint({ next: true }, { expectedRevision: 0 }),
      (err) => {
        const e = /** @type {any} */ (err);
        assert.equal(e.code, 'STALE_RUNTIME');
        assert.match(e.message, /revision=1/);
        return true;
      },
    );

    // 纠偏传入正确 expectedRevision: 1 后成功写入 revision: 2
    const correctedRes = await link.sdk.save.checkpoint({ next: true }, { expectedRevision: 1 });
    assert.equal(correctedRes.revision, 2);
  } finally {
    link.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('扫雷规则动作 -> 真实 MessagePort 存盘 -> 关闭 pauseAck -> 重建恢复同进度完整闭环', async () => {
  const MinesweeperEngine = await loadMinesweeperEngine();
  const { SaveStore, SqliteSaveBackend } = await loadHostStorage();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-client-minesweeper-'));
  const dbPath = path.join(tmpDir, 'saves.db');
  const store = new SaveStore(new SqliteSaveBackend({ dbPath }));

  const GAME_ID = 'example.minesweeping';
  const SAVE_ID = 'save-p6-real-port';
  const PLAYER_ID = 'player-real-p6';

  // 第一轮：启动游戏与 SDK，玩若干步
  const leaseA = createRuntimeLease({
    gameId: GAME_ID,
    saveId: SAVE_ID,
    runtimeInstanceId: 'rt-inst-ms-1',
    nonce: 'nonce-ms-1',
    generation: 1,
  });
  leaseA.state = 'running';
  leaseA.portBound = true;

  /** @type {((val: any) => void) | null} */
  let pauseAckResolver = null;
  const pausePromise = new Promise((resolve) => {
    pauseAckResolver = resolve;
  });

  const linkA = connectSDKToDispatcher({
    lease: leaseA,
    playerId: PLAYER_ID,
    initialSeed: 99999,
    initialElapsedMs: 0,
    onCheckpoint: (input) => store.writeCheckpoint(input),
    onPauseAck: (payload) => {
      if (pauseAckResolver) pauseAckResolver(payload);
    },
  });

  const engineA = new MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 99999 });
  engineA.reveal(4, 4);
  engineA.reveal(0, 0);
  engineA.toggleFlag(2, 2);
  engineA.tick(2500);

  linkA.sdk.clock.resume();
  linkA.sdk.clock.tick?.(2500);

  // 1. 游戏中正常检查点：通过 MessagePort 存盘
  const snapshotA = engineA.serialize();
  const checkpointRes = await linkA.sdk.save.checkpoint(snapshotA);
  assert.equal(checkpointRes.revision, 1);

  // 2. 模拟触发关闭与 pause 钩子，回传 pauseAck
  let pauseHookExecuted = false;
  linkA.sdk.lifecycle.register({
    pause: async () => {
      pauseHookExecuted = true;
      return engineA.serialize();
    },
  });

  const triggered = linkA.dispatcher.triggerPause({ reason: 'user_close' });
  assert.equal(triggered, true);

  const pauseAckPayload = await pausePromise;
  assert.equal(pauseHookExecuted, true);
  assert.equal(pauseAckPayload.generation, 1);
  assert.equal(pauseAckPayload.revision, 1);

  // 3. 释放第一轮所有端口与监听器
  linkA.dispose();

  // 4. 从 SQLite 持久化介质中读出最新存档
  const readRes = await store.readCheckpoint(GAME_ID, SAVE_ID, {
    playerId: PLAYER_ID,
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1],
    installedCommits: ['current'],
  });
  assert.equal(readRes.ok, true);
  assert.equal(readRes.save.revision, 1);
  assert.deepEqual(readRes.save.state, snapshotA);
  assert.equal(readRes.save.rngState, linkA.sdk.random.getState());

  // 5. 第二轮重建：基于恢复出的存档数据重建全新 SDK 与规则引擎
  const leaseB = createRuntimeLease({
    gameId: GAME_ID,
    saveId: SAVE_ID,
    runtimeInstanceId: 'rt-inst-ms-2',
    nonce: 'nonce-ms-2',
    generation: 2,
  });
  leaseB.state = 'running';
  leaseB.portBound = true;

  const linkB = connectSDKToDispatcher({
    lease: leaseB,
    playerId: PLAYER_ID,
    initialElapsedMs: readRes.save.elapsedGameMs,
    initialRngState: readRes.save.rngState,
    initialRevision: readRes.save.revision,
    onCheckpoint: (input) => store.writeCheckpoint(input),
  });

  const engineB = new MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 99999 });
  engineB.restore(readRes.save.state);

  // 验证重建后状态与第一轮关闭前 100% 一致
  assert.deepEqual(engineB.serialize(), snapshotA, '重建后棋盘必须与关闭前完全一致');
  assert.equal(linkB.sdk.clock.getElapsedMs(), readRes.save.elapsedGameMs, '虚拟时钟必须恢复');
  assert.equal(linkB.sdk.random.getState(), readRes.save.rngState, 'RNG 必须恢复');

  // 恢复后继续操作：翻开 (8, 8)，并与连续对照引擎比对
  engineB.reveal(8, 8);
  const continuedState = engineB.serialize();

  const controlEngine = new MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 99999 });
  controlEngine.restore(snapshotA);
  controlEngine.reveal(8, 8);
  assert.deepEqual(continuedState, controlEngine.serialize(), '恢复后后续游戏操作与连续运行严格一致');

  // 恢复后发起下一次检查点：expectedRevision 自动为 1，写入成为 revision 2
  const nextCheckpoint = await linkB.sdk.save.checkpoint(continuedState);
  assert.equal(nextCheckpoint.revision, 2, '恢复后后续检查点 revision 必须单调自增到 2');

  linkB.dispose();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
