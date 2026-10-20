// @ts-check
/**
 * 游戏 SDK v1 表面与功能单测（证据分栏：UNIT/MOCK）。
 *
 * 验证重点：
 * 1. SDK 表面完整且仅暴露安全白名单能力：ai、save、lifecycle、clock、random、assets。
 * 2. 严禁暴露宿主对象：绝对不含 Cordis ctx、DOM、DSH 工具、runtimeToken 等凭据。
 * 3. SeededRandom 的可复现性，支持 getState/setState 存档与恢复，序列完全一致。
 * 4. GameClock 虚拟时钟仅在 Running 阶段累计，暂停时冻结，不按现实时间补跑。
 * 5. 端到端 MessagePort 消息封装：ai.generate、save.checkpoint、lifecycle.ready 及 pause 自动响应。
 *
 * 运行：node --test test/sdk.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createGameCenterSDK, createSeededRandom, createGameClock } from '../src/sdk/index.js';

test('SeededRandom: 相同种子生成完全一致的确定性序列', () => {
  const rng1 = createSeededRandom(42);
  const rng2 = createSeededRandom(42);

  const seq1 = Array.from({ length: 10 }, () => rng1.next());
  const seq2 = Array.from({ length: 10 }, () => rng2.next());
  assert.deepEqual(seq1, seq2);

  const ints1 = Array.from({ length: 10 }, () => rng1.nextInt(1, 100));
  const ints2 = Array.from({ length: 10 }, () => rng2.nextInt(1, 100));
  assert.deepEqual(ints1, ints2);
});

test('SeededRandom: 状态导出与恢复后随机数序列完全无缝接续', () => {
  const rng = createSeededRandom('test-seed-123');
  for (let i = 0; i < 5; i += 1) rng.next();

  // 记录状态
  const savedState = rng.getState();
  const nextThreeExpected = [rng.next(), rng.next(), rng.next()];

  // 模拟从存档状态恢复
  const restoredRng = createSeededRandom(1); // 初始种子不同
  restoredRng.setState(savedState);
  const nextThreeActual = [restoredRng.next(), restoredRng.next(), restoredRng.next()];

  assert.deepEqual(nextThreeActual, nextThreeExpected, '从 rngState 恢复后序列必须完全一致');
});

test('GameClock: 仅在 Running 阶段累计游戏时间，暂停时不按现实时间偷跑', async () => {
  let simulatedWallTime = 1000;
  const clock = createGameClock({
    initialElapsedMs: 500,
    getWallTime: () => simulatedWallTime,
  });

  // 初始为冻结状态
  assert.equal(clock.isClockFrozen(), true);
  assert.equal(clock.getElapsedMs(), 500);

  // 现实时间流逝 200ms，但在未 resume 前虚拟时钟不累加
  simulatedWallTime += 200;
  assert.equal(clock.getElapsedMs(), 500);

  // 启动时钟
  clock.resume();
  assert.equal(clock.isClockFrozen(), false);

  // 活跃阶段流逝 300ms
  simulatedWallTime += 300;
  assert.equal(clock.getElapsedMs(), 800);

  // 暂停时钟
  clock.pause();
  assert.equal(clock.isClockFrozen(), true);

  // 暂停期间现实时间流逝 10000ms（模拟后台或关闭弹层）
  simulatedWallTime += 10000;
  assert.equal(clock.getElapsedMs(), 800, '暂停期间游戏虚拟时间不得偷跑');

  // 恢复后继续正常累加
  clock.resume();
  simulatedWallTime += 150;
  assert.equal(clock.getElapsedMs(), 950);
});

test('SDK 表面安全边界：仅暴露受限白名单能力，绝对无宿主对象与凭据泄露', () => {
  // @ts-expect-error test mock
  const channel = new MessageChannel();
  // @ts-expect-error worker_threads port vs DOM port
  const sdk = createGameCenterSDK({ port: channel.port1 });

  // 1. 白名单能力必须存在
  assert.equal(typeof sdk.ai?.generate, 'function');
  assert.equal(typeof sdk.ai?.cancel, 'function');
  assert.equal(typeof sdk.save?.checkpoint, 'function');
  assert.equal(typeof sdk.lifecycle?.ready, 'function');
  assert.equal(typeof sdk.lifecycle?.register, 'function');
  assert.ok(sdk.clock);
  assert.ok(sdk.random);
  assert.ok(sdk.assets);

  // 2. 绝对不可暴露宿主能力
  const keys = Object.keys(sdk);
  assert.deepEqual(keys.sort(), ['ai', 'assets', 'clock', 'lifecycle', 'random', 'save']);

  const forbidden = [
    'runtimeToken',
    'tokenDigest',
    'token',
    'ctx',
    'remote',
    'document',
    'window',
    'tools',
    'fetch',
    'eval',
  ];
  for (const f of forbidden) {
    // @ts-expect-error property access check
    assert.equal(sdk[f], undefined, `SDK 表面严禁暴露 ${f}`);
  }

  // 3. 资产路径安全校验
  assert.equal(sdk.assets.resolve('assets/mine.png'), 'assets/mine.png');
  assert.throws(() => sdk.assets.resolve('../secret.txt'), /禁止路径逃逸/);
  assert.throws(() => sdk.assets.resolve('/etc/passwd'), /禁止路径逃逸/);

  channel.port1.close();
  channel.port2.close();
});

test('SDK 与 Bridge 消息端到端全链路联动测试', async () => {
  // @ts-expect-error test mock
  const channel = new MessageChannel();
  const hostPort = channel.port2;
  // @ts-expect-error worker_threads port vs DOM port
  const sdk = createGameCenterSDK({ port: channel.port1 });

  /** @type {any[]} */
  const hostReceived = [];
  hostPort.on('message', (msg) => {
    hostReceived.push(msg);

    // 模拟 Host 端正确响应
    if (msg.method === 'lifecycle.ready') {
      hostPort.postMessage({ bridgeVersion: 1, requestId: msg.requestId, ok: true, payload: { ready: true } });
    } else if (msg.method === 'ai.generate') {
      hostPort.postMessage({
        bridgeVersion: 1,
        requestId: msg.requestId,
        ok: true,
        payload: {
          operationId: msg.payload.operationId,
          output: { board: [[0, 1], [1, 1]] },
          binding: { providerId: 'fixture', modelId: 'mock-minesweeper' },
          structuredNative: true,
        },
      });
    } else if (msg.method === 'save.checkpoint') {
      hostPort.postMessage({
        bridgeVersion: 1,
        requestId: msg.requestId,
        ok: true,
        payload: { revision: 1 },
      });
    }
  });

  // 1. lifecycle.ready
  await sdk.lifecycle.ready();
  assert.equal(hostReceived[0]?.method, 'lifecycle.ready');

  // 2. ai.generate
  const aiRes = await sdk.ai.generate({
    slot: 'generator',
    operationId: 'op-001',
    messages: [{ role: 'user', text: '生成9x9扫雷' }],
  });
  assert.equal(aiRes.operationId, 'op-001');
  assert.deepEqual(aiRes.output, { board: [[0, 1], [1, 1]] });

  // 3. save.checkpoint
  const saveRes = await sdk.save.checkpoint({ turn: 1, grid: [0, 0] });
  assert.equal(saveRes.revision, 1);

  // 4. 模拟父窗口下发 lifecycle:pause 指令，测试自动触发 pause 钩子并回传 pauseAck
  let pauseHookCalled = false;
  let pauseAckReceived = false;

  sdk.lifecycle.register({
    pause: async () => {
      pauseHookCalled = true;
      return { pausedAtTurn: 1 };
    },
  });

  // 父窗口向游戏下发暂停指令
  hostPort.postMessage({ type: 'lifecycle:pause', generation: 2, reason: 'user_close' });

  await new Promise((resolve) => {
    hostPort.on('message', (msg) => {
      if (msg.method === 'lifecycle.pauseAck') {
        pauseAckReceived = true;
        assert.equal(msg.payload.generation, 2);
        assert.deepEqual(msg.payload.snapshot, { pausedAtTurn: 1 });
        resolve(null);
      }
    });
  });

  assert.equal(pauseHookCalled, true, '父窗口下发 pause 指令后必须触发注册的 pause 钩子');
  assert.equal(pauseAckReceived, true, '游戏完成保存后必须向宿主回传 pauseAck 确认');

  channel.port1.close();
  channel.port2.close();
});

test('SDK 恢复同进度支撑：注入存档中的 initialElapsedMs 与 initialRngState 重建后完全一致且随机序列不跳变', () => {
  // 模拟第一轮游戏进行一段逻辑并存档
  // @ts-expect-error test mock
  const channel1 = new MessageChannel();
  // @ts-expect-error worker_threads port vs DOM port
  const sdk1 = createGameCenterSDK({ port: channel1.port1, initialSeed: 'initial-game-seed-888' });

  // 1. 模拟游戏推进：时钟流逝与生成若干随机数
  sdk1.clock.resume();
  for (let i = 0; i < 7; i += 1) sdk1.random.next();

  // 2. 模拟关闭时保存得到的存档字段
  const savedElapsedMs = 12500; // 累计 12.5s
  sdk1.clock.reset(savedElapsedMs);
  const savedRngState = sdk1.random.getState();

  // 记录若继续运行预期的后三个随机数
  const expectedNextRandoms = [sdk1.random.next(), sdk1.random.next(), sdk1.random.next()];

  // 3. 模拟退出销毁后，从存档中恢复重建全新 SDK 实例
  // @ts-expect-error test mock
  const channel2 = new MessageChannel();
  // @ts-expect-error worker_threads port vs DOM port
  const sdkRestored = createGameCenterSDK({
    port: channel2.port1,
    initialElapsedMs: savedElapsedMs,
    initialRngState: savedRngState,
  });

  // 4. 验证恢复后的时钟与随机数状态与存档完全一致
  assert.equal(sdkRestored.clock.getElapsedMs(), savedElapsedMs, '恢复后的虚拟累计时间必须等于存档值');
  assert.equal(sdkRestored.random.getState(), savedRngState, '恢复后的随机数内部状态必须等于存档值');

  // 5. 验证恢复后接续生成的随机数序列与第一轮完全一致，不跳变、不补跑
  const actualNextRandoms = [sdkRestored.random.next(), sdkRestored.random.next(), sdkRestored.random.next()];
  assert.deepEqual(actualNextRandoms, expectedNextRandoms, '恢复后的后续随机数序列必须与关闭前完全一致');

  channel1.port1.close();
  channel1.port2.close();
  channel2.port1.close();
  channel2.port2.close();
});

test('SDK operationId 与 expectedRevision：支持重试复用同一 op，不同动作同状态生成不同 op，支持 initialRevision 恢复', async () => {
  // @ts-expect-error test mock
  const channel = new MessageChannel();
  const hostPort = channel.port2;
  // @ts-expect-error worker_threads port
  const sdk = createGameCenterSDK({ port: channel.port1, initialRevision: 2 });

  /** @type {any[]} */
  const checkpointsReceived = [];
  let nextRevisionToReturn = 3;

  hostPort.on('message', (msg) => {
    if (msg.method === 'save.checkpoint') {
      const isReplay =
        checkpointsReceived.length > 0 &&
        msg.payload.operationId === checkpointsReceived[checkpointsReceived.length - 1]?.operationId;
      checkpointsReceived.push(msg.payload);
      hostPort.postMessage({
        bridgeVersion: 1,
        requestId: msg.requestId,
        ok: true,
        payload: {
          revision: isReplay ? nextRevisionToReturn - 1 : nextRevisionToReturn,
          idempotentReplay: isReplay,
        },
      });
      if (!isReplay) {
        nextRevisionToReturn += 1;
      }
    }
  });

  try {
    // 1. 动作 1：由于传入了 initialRevision: 2，首次 expectedRevision 为 2
    const sameState = { board: [0, 1] };
    const res1 = await sdk.save.checkpoint(sameState);
    assert.equal(checkpointsReceived[0]?.expectedRevision, 2, '基于 initialRevision 恢复后 expectedRevision 必须对齐');
    const op1 = checkpointsReceived[0]?.operationId;
    assert.ok(op1 && op1.startsWith('act-'), '自动生成的 operationId 必须合法');

    // 2. 模拟失败重试：显式声明 retry: true，必须复用相同的 operationId 与 expectedRevision
    const resRetry = await sdk.save.checkpoint(sameState, { retry: true });
    assert.equal(checkpointsReceived[1]?.operationId, op1, '重试时必须复用相同的 operationId');
    assert.equal(checkpointsReceived[1]?.expectedRevision, 2, '重试时必须复用相同的 expectedRevision');

    // 3. 动作 2：即便状态完全相同，作为新动作调用必须生成不同的 operationId，且 expectedRevision 递增
    const res2 = await sdk.save.checkpoint(sameState);
    const op2 = checkpointsReceived[2]?.operationId;
    assert.notEqual(op2, op1, '不同动作即使状态相同，也必须产生不同的 operationId');
    assert.equal(checkpointsReceived[2]?.expectedRevision, 3, '新动作 expectedRevision 必须自动推进到最新已知版本');
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});
