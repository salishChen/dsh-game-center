// @ts-check
/**
 * 阶段1 A9 验收项测试：游戏越权与 Bridge 安全防御（证据分栏：UNIT/MOCK）。
 *
 * 验证重点（A9 验收指标）：
 * 1. 跨存档越权：payload 伪造或跨存档 saveId 必须被拒绝并返回 PROTOCOL_INVALID。
 * 2. 伪造 gameId：payload 伪造其他 gameId 必须被拒绝并返回 PROTOCOL_INVALID。
 * 3. 未握手直连：专用 MessagePort 尚未建立或未握手直连，调用必须被拒绝并返回 PROTOCOL_INVALID。
 * 4. 超大消息防御：超过 256 KiB (BRIDGE_MAX_MESSAGE_BYTES) 必须被拒绝并返回 MESSAGE_TOO_LARGE。
 * 5. 暂停后调用拦截：进入暂停后除 pauseAck 外的所有新请求一律严格返回 PAUSED。
 * 6. 旧代次迟到写入拦截：请求代次与当前代次不符，一律严格返回 STALE_RUNTIME。
 * 7. 非白名单方法拦截：任何不在 BRIDGE_METHODS 内的方法一律拒绝为 PROTOCOL_INVALID。
 * 8. 凭据绝对隔离：出站消息全局扫描，绝对不泄露 runtimeToken、Cordis ctx 或 DOM 对象。
 *
 * 运行：node --test test/bridge-security-a9.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createBridgeDispatcher } from '../src/bridge/dispatcher.js';
import { createRuntimeLease, requestPause } from '../src/runtime/lease.js';
import { BRIDGE_MAX_MESSAGE_BYTES, BRIDGE_METHODS } from '../src/bridge/host-bridge.js';

/**
 * 辅助函数：通过 MessagePort 发送消息并等待 Bridge 响应。
 * @param {any} clientPort
 * @param {any} message
 * @returns {Promise<any>}
 */
function sendBridgeMessage(clientPort, message, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`sendBridgeMessage 请求超时: ${message.method}`));
    }, timeoutMs);

    const handler = (eventOrData) => {
      clearTimeout(timer);
      const data = eventOrData && typeof eventOrData === 'object' && 'data' in eventOrData ? eventOrData.data : eventOrData;
      if (typeof clientPort.off === 'function') {
        clientPort.off('message', handler);
      }
      resolve(data);
    };
    if (typeof clientPort.on === 'function') {
      clientPort.on('message', handler);
    } else {
      clientPort.onmessage = handler;
    }
    clientPort.postMessage(message);
  });
}

function setupBridgeHarness(leaseOptions = {}, dispatcherOverrides = {}) {
  const lease = createRuntimeLease({
    gameId: 'legit-game',
    saveId: 'save-001',
    runtimeInstanceId: 'rt-instance-1',
    nonce: 'nonce-123',
    generation: 2,
    ...leaseOptions,
  });

  // @ts-expect-error test mock
  const channel = new MessageChannel();
  const clientPort = channel.port1;
  const hostPort = channel.port2;

  const defaultDispatcherOpts = {
    lease,
    // @ts-expect-error worker_threads port
    port: hostPort,
    playerId: 'player-test-a9',
    onCheckpoint: async () => ({ revision: 10 }),
    onAiGenerate: async (payload) => ({
      operationId: payload.operationId,
      output: { ok: true },
      binding: { providerId: 'fixture', modelId: 'mock' },
      structuredNative: true,
    }),
  };

  const finalOpts = { ...defaultDispatcherOpts, ...dispatcherOverrides };
  if (dispatcherOverrides.onAiGenerate === null) {
    delete finalOpts.onAiGenerate;
  }

  const dispatcher = createBridgeDispatcher(finalOpts);

  // 默认模拟握手成功并激活状态
  lease.portBound = true;
  lease.state = 'running';

  return {
    lease,
    clientPort,
    hostPort,
    dispatcher,
    close: () => {
      clientPort.close();
      hostPort.close();
    },
  };
}

test('A9-1 跨存档越权：payload 伪造/跨 saveId 访问必须被严格拒绝为 PROTOCOL_INVALID', async () => {
  const h = setupBridgeHarness();

  const response = await sendBridgeMessage(h.clientPort, {
    bridgeVersion: 1,
    requestId: 'attack-save-01',
    method: 'save.checkpoint',
    payload: {
      saveId: 'victim-other-save', // 试图篡改或写入他人存档
      state: { coins: 999999 },
    },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PROTOCOL_INVALID');
  assert.match(response.error.message, /禁止跨存档越权/);

  h.close();
});

test('A9-2 伪造 gameId：payload 伪造其他游戏标识必须被严格拒绝为 PROTOCOL_INVALID', async () => {
  const h = setupBridgeHarness();

  const response = await sendBridgeMessage(h.clientPort, {
    bridgeVersion: 1,
    requestId: 'attack-game-01',
    method: 'save.checkpoint',
    payload: {
      gameId: 'attacker-other-game', // 试图篡改所属游戏
      state: {},
    },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PROTOCOL_INVALID');
  assert.match(response.error.message, /禁止跨游戏越权/);

  h.close();
});

test('A9-3 未握手直连：专用端口未绑定或状态未就绪直接调用必须被拒绝', async () => {
  const h = setupBridgeHarness();
  h.lease.portBound = false; // 模拟未完成握手绑定

  const response = await sendBridgeMessage(h.clientPort, {
    bridgeVersion: 1,
    requestId: 'no-handshake-01',
    method: 'save.checkpoint',
    payload: { state: {} },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PROTOCOL_INVALID');
  assert.match(response.error.message, /专用 MessagePort 尚未建立/);

  h.close();
});

test('A9-4 超大消息攻击：超过 256 KiB 必须被拒绝为 MESSAGE_TOO_LARGE', async () => {
  const h = setupBridgeHarness();

  // 构造超过 256 KiB 的畸形超大负载
  const oversizedPayload = {
    padding: 'A'.repeat(BRIDGE_MAX_MESSAGE_BYTES + 1024),
  };

  const response = await sendBridgeMessage(h.clientPort, {
    bridgeVersion: 1,
    requestId: 'big-msg-01',
    method: 'save.checkpoint',
    payload: oversizedPayload,
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MESSAGE_TOO_LARGE');

  h.close();
});

test('A9-5 暂停后调用拦截：进入暂停后所有常规请求一律被拦截并返回 PAUSED', async () => {
  const h = setupBridgeHarness();

  // 触发暂停
  requestPause(h.lease, { reason: 'user_close' });
  assert.equal(h.lease.state, 'pausing');

  // 尝试在暂停状态下提交新 AI 生成
  const response = await sendBridgeMessage(h.clientPort, {
    bridgeVersion: 1,
    requestId: 'paused-call-01',
    method: 'ai.generate',
    payload: { slot: 'narrator', operationId: 'op-paused-1' },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PAUSED');
  assert.match(response.error.message, /不再接受新请求/);

  h.close();
});

test('A9-6 旧代次迟到调用拦截：陈旧代次的请求必须被拒绝并返回 STALE_RUNTIME', async () => {
  const h = setupBridgeHarness();
  assert.equal(h.lease.generation, 2);

  // 发送携带旧代次 (generation: 1) 的请求
  const response = await sendBridgeMessage(h.clientPort, {
    bridgeVersion: 1,
    requestId: 'stale-gen-01',
    method: 'save.checkpoint',
    payload: {
      generation: 1, // 旧代次
      state: {},
    },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'STALE_RUNTIME');
  assert.match(response.error.message, /已失效的运行代次/);

  h.close();
});

test('A9-7 非白名单方法拦截：请求不在白名单内的方法必须被拒绝为 PROTOCOL_INVALID', async () => {
  const h = setupBridgeHarness();

  const forbiddenMethods = ['eval', 'fs.readFile', 'dsh.tools', 'process.exit', 'window.open'];
  for (const method of forbiddenMethods) {
    const response = await sendBridgeMessage(h.clientPort, {
      bridgeVersion: 1,
      requestId: `forbidden-${method}`,
      method,
      payload: {},
    });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'PROTOCOL_INVALID');
    assert.match(response.error.message, /不在白名单内/);
  }

  h.close();
});

test('A9-8 出站凭据绝对隔离：Bridge 出站消息严禁携带 runtimeToken、Cordis ctx 或 DOM 对象', async () => {
  const h = setupBridgeHarness();

  const response = await sendBridgeMessage(h.clientPort, {
    bridgeVersion: 1,
    requestId: 'sec-check-01',
    method: 'save.checkpoint',
    payload: { operationId: 'op-sec-01', expectedRevision: 0, state: { score: 100 } },
  });

  assert.equal(response.ok, true);
  const serialized = JSON.stringify(response);

  // 严禁包含凭据关键词或泄露
  assert.equal(serialized.includes('runtimeToken'), false);
  assert.equal(serialized.includes('tokenDigest'), false);
  assert.equal(serialized.includes('ctx'), false);
  assert.equal(serialized.includes('Cordis'), false);

  h.close();
});

test('A9-11 存档检查点必填字段防御：缺少 playerId、operationId 或 expectedRevision 一律严格返回 PROTOCOL_INVALID', async () => {
  // 1. 宿主未绑定 playerId
  const hNoPlayer = setupBridgeHarness({}, { playerId: '' });
  const resNoPlayer = await sendBridgeMessage(hNoPlayer.clientPort, {
    bridgeVersion: 1,
    requestId: 'chk-no-player',
    method: 'save.checkpoint',
    payload: { operationId: 'op-1', expectedRevision: 0, state: {} },
  });
  assert.equal(resNoPlayer.ok, false);
  assert.equal(resNoPlayer.error.code, 'PROTOCOL_INVALID');
  assert.match(resNoPlayer.error.message, /宿主未绑定可信 playerId/);
  hNoPlayer.close();

  // 2. 缺少 operationId
  const hValid = setupBridgeHarness();
  const resNoOp = await sendBridgeMessage(hValid.clientPort, {
    bridgeVersion: 1,
    requestId: 'chk-no-op',
    method: 'save.checkpoint',
    payload: { expectedRevision: 0, state: {} },
  });
  assert.equal(resNoOp.ok, false);
  assert.equal(resNoOp.error.code, 'PROTOCOL_INVALID');
  assert.match(resNoOp.error.message, /必须提供 operationId/);

  // 3. 缺少或非法的 expectedRevision
  const resBadRev = await sendBridgeMessage(hValid.clientPort, {
    bridgeVersion: 1,
    requestId: 'chk-bad-rev',
    method: 'save.checkpoint',
    payload: { operationId: 'op-2', expectedRevision: -1, state: {} },
  });
  assert.equal(resBadRev.ok, false);
  assert.equal(resBadRev.error.code, 'PROTOCOL_INVALID');
  assert.match(resBadRev.error.message, /expectedRevision 必须为非负整数/);

  hValid.close();
});

test('A9-9 频率超限拦截：错误码必须为 RATE_LIMIT（与 protocol ERROR_CODES 一致）', async () => {
  const h = setupBridgeHarness();

  // 连续发送超过频率上限的请求（默认 RATE_MAX_REQUESTS 为 20）
  let rateLimitResponse = null;
  for (let i = 0; i < 25; i += 1) {
    const res = await sendBridgeMessage(h.clientPort, {
      bridgeVersion: 1,
      requestId: `spam-req-${i}`,
      method: 'ai.cancel',
      payload: { operationId: `op-${i}` },
    });
    if (!res.ok && res.error?.code === 'RATE_LIMIT') {
      rateLimitResponse = res;
      break;
    }
  }

  assert.ok(rateLimitResponse, '超频请求必须被频率限制器拦截');
  assert.equal(rateLimitResponse.ok, false);
  assert.equal(rateLimitResponse.error.code, 'RATE_LIMIT', '错误码必须与 protocol 中的 RATE_LIMIT 权威定义一致');
  assert.equal(rateLimitResponse.error.retryable, true);

  h.close();
});

test('A9-10 零真实模型调用断言：Dispatcher 严禁调用真实模型，未装配转发时必须明确失败', async () => {
  // 不提供自定义 onAiGenerate：2026-10-21 起不再伪造 fixture 成功，
  // 因为游戏的 schema 校验必然拒绝那条纯文本，玩家看到的是静默降级/报错。
  const defaultDispatcherHarness = setupBridgeHarness({}, { onAiGenerate: null });

  // 1. 未装配转发 → 明确失败（CAPABILITY_UNAVAILABLE），不得返回成功信封
  const res1 = await sendBridgeMessage(defaultDispatcherHarness.clientPort, {
    bridgeVersion: 1,
    requestId: 'ai-no-forward-01',
    method: 'ai.generate',
    payload: { slot: 'minesweeper', operationId: 'op-fixed-1' },
  });

  assert.equal(res1.ok, false, '未装配 AI 转发时不得返回成功信封');
  assert.equal(res1.error.code, 'CAPABILITY_UNAVAILABLE', '错误码必须与 protocol 权威定义一致');
  assert.equal(res1.error.retryable, false);
  assert.equal(JSON.stringify(res1).includes('fixture'), false, '不得再出现 fixture 伪成功文本');

  // 2. 静态断言：dispatcher.js 源码中绝无任何 .stream( 或真实模型服务引用
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dispatcherSrc = readFileSync(path.resolve(here, '../src/bridge/dispatcher.js'), 'utf8');

  assert.equal(dispatcherSrc.includes('.stream('), false, 'Dispatcher 严禁包含真实流式模型调用 .stream(');
  assert.equal(dispatcherSrc.includes('ctx.llm'), false, 'Dispatcher 严禁直接访问宿主 llm 服务');

  defaultDispatcherHarness.close();
});
