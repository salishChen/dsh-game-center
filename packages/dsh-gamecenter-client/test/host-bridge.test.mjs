/**
 * 专用 MessagePort Bridge 的 Host 侧校验测试（node --test）。
 *
 * 对应验收场景「游戏尝试跨存档访问或调用主 DSH API：Bridge/Host 拒绝」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDSHAKE_TAG,
  createNonce,
  createRateLimiter,
  outboundError,
  outboundOk,
  parseInbound,
  verifyHandshake,
} from '../src/bridge/host-bridge.js';

const IFrameSource = Object.freeze({ name: 'fake-iframe-window' });
const ATTACKER = Object.freeze({ name: 'attacker-window' });

test('握手只认确定的 event.source + 一次性 nonce + 运行实例', () => {
  const good = {
    tag: HANDSHAKE_TAG,
    runtimeInstanceId: 'rt-1',
    nonce: 'nonce-1',
    bridgeVersion: 1,
  };
  const expected = { window: IFrameSource, runtimeInstanceId: 'rt-1', nonce: 'nonce-1', generation: 3 };

  assert.deepEqual(verifyHandshake({ data: good, source: IFrameSource, expected }), { ok: true, generation: 3 });

  // 来源不对：即便 payload 完全正确也拒绝（沙箱下 origin 可能是 null，不能只信 origin）。
  assert.equal(verifyHandshake({ data: good, source: ATTACKER, expected }).ok, false);

  // nonce 不对 / 缺失
  assert.equal(verifyHandshake({ data: { ...good, nonce: 'guess' }, source: IFrameSource, expected }).ok, false);
  assert.equal(verifyHandshake({ data: { ...good, nonce: '' }, source: IFrameSource, expected }).ok, false);

  // 运行实例不对
  assert.equal(verifyHandshake({ data: { ...good, runtimeInstanceId: 'rt-2' }, source: IFrameSource, expected }).ok, false);

  // 不是我们的握手 tag
  assert.equal(verifyHandshake({ data: { ...good, tag: 'other' }, source: IFrameSource, expected }).ok, false);

  // bridge 主版本不对
  assert.equal(verifyHandshake({ data: { ...good, bridgeVersion: 2 }, source: IFrameSource, expected }).ok, false);

  // 非对象
  assert.equal(verifyHandshake({ data: null, source: IFrameSource, expected }).ok, false);
});

test('入站信封：白名单 + 版本 + requestId + 可序列化', () => {
  const ok = parseInbound({ bridgeVersion: 1, requestId: 'r1', method: 'ai.generate', payload: { slot: 'narrator' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.method, 'ai.generate');

  const unknownMethod = parseInbound({ bridgeVersion: 1, requestId: 'r2', method: 'eval', payload: {} });
  assert.equal(unknownMethod.ok, false);
  assert.equal(unknownMethod.code, 'PROTOCOL_INVALID');

  const wrongVersion = parseInbound({ bridgeVersion: 9, requestId: 'r3', method: 'ai.generate', payload: {} });
  assert.equal(wrongVersion.ok, false);

  const noRequestId = parseInbound({ bridgeVersion: 1, method: 'ai.generate', payload: {} });
  assert.equal(noRequestId.ok, false);

  const circular = { bridgeVersion: 1, requestId: 'r4', method: 'ai.generate' };
  circular.payload = circular;
  const notSerializable = parseInbound(circular);
  assert.equal(notSerializable.ok, false, '循环引用必须被拒绝而不是抛异常');

  assert.equal(parseInbound('string').ok, false);
  assert.equal(parseInbound(null).ok, false);
});

test('入站信封：超过大小上限直接拒绝（不截断、不尝试解析）', () => {
  const big = { bridgeVersion: 1, requestId: 'r5', method: 'ai.generate', payload: { text: 'x'.repeat(3_000_000) } };
  const result = parseInbound(big);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MESSAGE_TOO_LARGE');
});

test('频率限制：窗口内超过配额拒绝，窗口滑动后恢复', () => {
  let now = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: () => now });
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false, '第 4 次必须被拒');
  now = 1001;
  assert.equal(limiter.tryAcquire(), true, '窗口滑动后恢复');
});

test('出站信封不含内部信息：错误只有 code / message / retryable', () => {
  const error = outboundError('r1', { code: 'CAPABILITY_UNAVAILABLE', message: '缺少生图能力' });
  assert.deepEqual(error, {
    bridgeVersion: 1,
    requestId: 'r1',
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: '缺少生图能力', retryable: false },
  });
  assert.equal(JSON.stringify(error).includes('stack'), false);

  const ok = outboundOk('r2', { text: 'hello' });
  assert.equal(ok.ok, true);
});

test('nonce 每次不同且长度足够', () => {
  const a = createNonce();
  const b = createNonce();
  assert.notEqual(a, b);
  assert.equal(a.length, 48);
  assert.match(a, /^[0-9a-f]+$/);
});
