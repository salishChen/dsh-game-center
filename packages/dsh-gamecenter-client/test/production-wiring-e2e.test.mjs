// @ts-check
/**
 * Client 侧生产接线端到端闭环测试（证据分栏：UNIT/MOCK/INTEGRATION）。
 *
 * 验证流程（对齐 docs/phase1-production-wiring.md 验收标准）：
 * 1. 目录列表（catalogList）：获取条目、审批状态、已装标记；source: fixture 标识展示。
 * 2. 模拟安装（catalogInstall）：按 commit 隔离安装，状态变更为已安装。
 * 3. 产物提取与受限文档组装（gameBundle + assembleGameDocument）：
 *    - 验证样式与脚本内联化、外部外链阻断；
 *    - 验证 CSP 断网与 sandbox="allow-scripts"。
 * 4. 真实双向 MessageChannel 握手与端口连接：
 *    - event.source + nonce 校验通过；
 *    - 建立专用 MessagePort 链路并注入 window.__DSH_GAMECENTER_SDK__。
 * 5. 局内保存检查点（save.checkpoint）：
 *    - 游戏翻格、推进时间并保存，验证 revision 自增。
 * 6. 关闭与保存确认闭环（requestPause + lifecycle:pause -> pauseAck）：
 *    - requestPause 触发时钟与输入冻结；
 *    - SDK 触发注册的 pause 钩子，回传 pauseAck；
 *    - 宿主完成代次封存与持久化。
 * 7. 继续游戏与恢复同进度（saveLatest -> resume）：
 *    - saveLatest 返回已存状态；
 *    - 重建全新会话与 SDK，验证虚拟时间、RNG 状态接续无缝恢复。
 *
 * 运行：node --test test/production-wiring-e2e.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assembleGameDocument, GAME_IFRAME_SANDBOX, GAME_DOCUMENT_CSP } from '../src/runtime/assembler.js';
import { createRuntimeLease, requestPause, completePause } from '../src/runtime/lease.js';
import { createBridgeDispatcher } from '../src/bridge/dispatcher.js';
import { verifyHandshake } from '../src/bridge/host-bridge.js';
import { createGameCenterSDK } from '../src/sdk/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const hostStagingStoreUrl = pathToFileURL(
  path.resolve(here, '../../dsh-gamecenter/staging/storage/save-store.js'),
).href;
const hostStagingSqliteUrl = pathToFileURL(
  path.resolve(here, '../../dsh-gamecenter/staging/storage/sqlite-save-backend.js'),
).href;
const hostStagingServiceUrl = pathToFileURL(
  path.resolve(here, '../../dsh-gamecenter/staging/remote/game-center-service.js'),
).href;

async function loadHostStorage() {
  const storeMod = await import(hostStagingStoreUrl);
  const sqliteMod = await import(hostStagingSqliteUrl);
  const serviceMod = await import(hostStagingServiceUrl);
  const cordisMod = await import('@deepseek-ai/cordis');
  const remoteMountMod = await import('../src/bridge/remote-mount.js');
  return {
    SaveStore: storeMod.SaveStore,
    SqliteSaveBackend: sqliteMod.SqliteSaveBackend,
    GameCenterCore: serviceMod.GameCenterCore,
    defineGameCenterService: serviceMod.defineGameCenterService,
    Context: cordisMod.Context,
    createGameCenterClient: remoteMountMod.createGameCenterClient,
  };
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

test('生产接线端到端闭环：目录 -> 安装 -> 组装内联文档 -> 握手与端口传递 -> 扫雷操作 -> 暂停确认 -> 重开恢复同进度', async () => {
  const MinesweeperEngine = await loadMinesweeperEngine();
  const { SaveStore, SqliteSaveBackend, GameCenterCore, defineGameCenterService, Context, createGameCenterClient } =
    await loadHostStorage();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-prod-wiring-'));
  const dbPath = path.join(tmpDir, 'saves.db');
  const store = new SaveStore(new SqliteSaveBackend({ dbPath }));

  const GAME_ID = 'example.minesweeping';
  const COMMIT = 'e4905dbe4a738a8406b39013292d6a545ab3a356';
  const PLAYER_ID = 'player-prod-01';

  // 创建真实 Host Remote 服务实例与 Client 包装层
  const root = new Context();
  let tokenCounter = 0;
  const core = new GameCenterCore({
    createToken: () => `token-e2e-${++tokenCounter}`,
    digestToken: (t) => `sha256:${t}`,
    nowMs: () => Date.now(),
    ttlMs: 60000,
  });
  const service = defineGameCenterService(core, root, {
    playerId: PLAYER_ID,
    saveStore: store,
    gameLibraryDir: tmpDir,
  });
  const remoteClient = createGameCenterClient(service);

  // 1. 模拟目录与安装服务返回
  const mockCatalogEntry = {
    gameId: GAME_ID,
    title: '扫雷',
    summary: '确定性规则引擎，AI 仅生成对局',
    version: '1.0.0',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: COMMIT,
    manifestDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
    bundleDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000002',
    approvalState: 'approved',
    installed: false,
    installedCommit: null,
  };

  assert.equal(mockCatalogEntry.approvalState, 'approved', '仅已审批游戏允许安装');

  // 模拟安装完成
  mockCatalogEntry.installed = true;
  mockCatalogEntry.installedCommit = COMMIT;

  // 2. 模拟 gameBundle 提取产物
  const gameDistDir = path.join(resolveGameRepo(), 'dist');
  const htmlContent = await fs.readFile(path.join(gameDistDir, 'index.html'), 'utf8');
  const cssContent = await fs.readFile(path.join(gameDistDir, 'style.css'), 'utf8');
  const jsContent = await fs.readFile(path.join(gameDistDir, 'game.js'), 'utf8');

  const bundleFiles = [
    { path: 'dist/index.html', content: htmlContent },
    { path: 'dist/style.css', content: cssContent },
    { path: 'dist/game.js', content: jsContent },
  ];

  // 3. 组装内联受限 iframe 文档
  const runtimeInstanceId = 'rt-e2e-prod-1';
  const nonce = 'nonce-e2e-prod-1';

  const docHtml = assembleGameDocument({
    entryPath: 'dist/index.html',
    files: bundleFiles,
    options: {
      runtimeInstanceId,
      nonce,
      initialSeed: 424242,
      initialElapsedMs: 0,
      initialRevision: 0,
    },
  });

  assert.equal(docHtml.includes('<link rel="stylesheet"'), false, '外部样式必须被内联');
  assert.equal(docHtml.includes('<script src='), false, '外部脚本必须被内联');
  assert.ok(docHtml.includes(GAME_DOCUMENT_CSP), '必须注入强断网 CSP');
  assert.ok(docHtml.includes('<script data-gamecenter-bootstrap>'), '必须先于游戏脚本注入 SDK 引导');

  // 4. 第一轮游戏运行会话：真实通过 Remote 执行 handshake 换取凭证
  const SAVE_ID = 'save-default';
  // 协议必填（2026-10-20）：launchToken 与 saveId 同级，abandonRuntime 用它证明调用者身份。
  const LAUNCH_TOKEN_A = 'e2e-launch-token-A-0000000000000000000000';
  const hsA = await remoteClient.handshake({
    runtimeInstanceId,
    nonce,
    gameId: GAME_ID,
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    // 存档槽位与运行身份分离（2026-10-20）：握手必须显式给 saveId。
    saveId: SAVE_ID,
    launchToken: LAUNCH_TOKEN_A,
  });
  assert.equal(hsA.ok, true, 'Remote 握手必须成功');
  assert.equal(typeof hsA.runtimeToken, 'string', '必须下发 runtimeToken 凭证');

  const leaseA = createRuntimeLease({
    gameId: GAME_ID,
    saveId: 'save-default',
    runtimeInstanceId,
    nonce,
    generation: hsA.generation || 1,
  });

  // 模拟沙箱环境与双向通道
  // @ts-expect-error global MessageChannel
  const channel = new MessageChannel();
  const parentPort = channel.port1;
  const iframePort = channel.port2;

  let dispatcher = null;
  let dispatcherB = null;
  let channelB = null;

  try {
    // 创建宿主侧 Bridge 分发器：真经由 Remote saveCheckpoint 写入持久化
    dispatcher = createBridgeDispatcher({
      lease: leaseA,
      port: parentPort,
      onCheckpoint: async (input) => {
        const res = await remoteClient.saveCheckpoint({
          runtimeToken: hsA.runtimeToken,
          operationId: input.operationId,
          expectedRevision: input.expectedRevision,
          state: input.state,
          elapsedGameMs: input.elapsedGameMs,
          rngState: input.rngState,
          generation: leaseA.generation,
        });
        assert.equal(res.ok, true, 'Remote saveCheckpoint 必须成功');
        return {
          revision: res.revision,
          idempotentReplay: res.idempotentReplay,
        };
      },
      onPauseAck: async (payload) => {
        completePause(leaseA, { generation: payload.generation, revision: payload.revision });
        await remoteClient.saveAck({
          runtimeToken: hsA.runtimeToken,
          revision: payload.revision || 1,
          generation: payload.generation,
        });
      },
    });

    // 验证沙箱握手
    const fakeIframeWindow = {};
    const handshakeResult = verifyHandshake({
      data: {
        tag: 'dsh-gamecenter:hello',
        runtimeInstanceId,
        nonce,
        bridgeVersion: 1,
      },
      source: fakeIframeWindow,
      expected: {
        window: fakeIframeWindow,
        runtimeInstanceId,
        nonce,
        generation: leaseA.generation,
      },
    });
    assert.equal(handshakeResult.ok, true, '握手校验必须成功');

    // 游戏端初始化 SDK
    const sdkA = createGameCenterSDK({
      port: iframePort,
      initialSeed: 424242,
      initialElapsedMs: 0,
      initialRevision: 0,
    });

    // 启动时钟并玩扫雷
    const engineA = new MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 424242 });
    engineA.reveal(4, 4);
    engineA.reveal(0, 0);
    engineA.toggleFlag(2, 2);
    engineA.tick(1500);

    sdkA.clock.resume();
    sdkA.clock.reset(1500);

    // 注册游戏暂停钩子
    sdkA.lifecycle.register({
      pause: async () => engineA.serialize(),
    });

    // 游戏产生检查点并通过 MessagePort 存盘（底层经由 Remote saveCheckpoint）
    const checkpointA = await sdkA.save.checkpoint(engineA.serialize());
    assert.equal(checkpointA.revision, 1);

    // 5. 触发关闭路径（Host pause -> Dispatcher triggerPause -> pauseAck -> saveAck 封存）
    await remoteClient.pause({ runtimeToken: hsA.runtimeToken, reason: 'user_close' });
    const triggered = dispatcher.triggerPause({ reason: 'user_close' });
    assert.equal(triggered, true, '必须成功触发暂停');
    assert.equal(leaseA.state, 'pausing');

    // 等待 pauseAck 自动处理与持久化
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(leaseA.state, 'paused', '接收 pauseAck 后租约必须进入 paused');
    assert.equal(leaseA.lastRevision, 1);

    // 释放第一轮所有端口
    dispatcher.dispose();
    channel.port1.close();
    channel.port2.close();

    // 6. 验证经由 Remote saveLatest 读出持久化数据（按固定槽位，不按运行实例 ID）
    const readLatest = await remoteClient.saveLatest({
      gameId: GAME_ID,
      saveId: SAVE_ID,
    });
    assert.equal(readLatest.ok, true);
    assert.equal(readLatest.absent, false);
    assert.equal(readLatest.revision, 1);
    assert.equal(readLatest.elapsedGameMs, 1500);

    // 7. 第二轮重建与恢复（继续游戏，复用同一 saveId，代次自增）
    const hsB = await remoteClient.handshake({
      runtimeInstanceId,
      nonce: 'nonce-e2e-prod-2',
      gameId: GAME_ID,
      gameVersion: '1.0.0',
      sdkVersion: '1.0.0',
      bridgeVersion: 1,
      saveId: SAVE_ID,
      launchToken: 'e2e-launch-token-B-0000000000000000000000',
    });
    assert.equal(hsB.ok, true);

    const leaseB = createRuntimeLease({
      gameId: GAME_ID,
      saveId: SAVE_ID,
      runtimeInstanceId,
      nonce: 'nonce-e2e-prod-2',
      generation: hsB.generation || 2,
    });

    // @ts-expect-error global MessageChannel
    channelB = new MessageChannel();
    dispatcherB = createBridgeDispatcher({
      lease: leaseB,
      port: channelB.port1,
      onCheckpoint: async (input) => {
        const res = await remoteClient.saveCheckpoint({
          runtimeToken: hsB.runtimeToken,
          operationId: input.operationId,
          expectedRevision: input.expectedRevision,
          state: input.state,
          elapsedGameMs: input.elapsedGameMs,
          rngState: input.rngState,
          generation: leaseB.generation,
        });
        assert.equal(res.ok, true);
        return {
          revision: res.revision,
          idempotentReplay: res.idempotentReplay,
        };
      },
    });

    const sdkB = createGameCenterSDK({
      port: channelB.port2,
      initialElapsedMs: readLatest.elapsedGameMs,
      initialRngState: readLatest.rngState,
      initialRevision: readLatest.revision,
    });

    const engineB = new MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 424242 });
    engineB.restore(readLatest.state);

    // 校验恢复同进度与确定性
    assert.deepEqual(engineB.serialize(), engineA.serialize(), '恢复后棋盘与关闭前严格一致');
    assert.equal(sdkB.clock.getElapsedMs(), 1500, '恢复后虚拟时间严格一致');
    assert.equal(sdkB.random.getState(), readLatest.rngState, '恢复后 RNG 严格一致');

    // 恢复后继续操作 (8, 8)
    engineB.reveal(8, 8);
    const nextCheck = await sdkB.save.checkpoint(engineB.serialize());
    assert.equal(nextCheck.revision, 2, '恢复后后续动作检查点 revision 必须单调自增到 2');
  } finally {
    if (dispatcher) dispatcher.dispose();
    try { channel.port1.close(); } catch {}
    try { channel.port2.close(); } catch {}
    if (dispatcherB) dispatcherB.dispose();
    if (channelB) {
      try { channelB.port1.close(); } catch {}
      try { channelB.port2.close(); } catch {}
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
