/**
 * 专用 MessagePort Bridge 的 Host 侧校验测试（node --test）。
 *
 * 对应验收场景「游戏尝试跨存档访问或调用主 DSH API：Bridge/Host 拒绝」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HANDSHAKE_TAG,
  createLaunchToken,
  createNonce,
  createRateLimiter,
  outboundError,
  outboundOk,
  parseInbound,
  verifyHandshake,
} from '../src/bridge/host-bridge.js';

const IFrameSource = Object.freeze({ name: 'fake-iframe-window' });
const ATTACKER = Object.freeze({ name: 'attacker-window' });
const here = path.dirname(fileURLToPath(import.meta.url));

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

test('nonce：无 CSPRNG 时必须抛错，不再静默降级到 Math.random', () => {
  const restore = withGlobalCrypto({ getRandomValues: undefined });
  try {
    assert.throws(
      () => createNonce(),
      /CSPRNG/,
      'nonce 同样是一次性握手凭证依据，无 CSPRNG 必须显式失败',
    );
  } finally {
    restore();
  }
  // 恢复后仍能正常生成（证明没有污染全局状态）
  assert.match(createNonce(), /^[0-9a-f]{48}$/);
});

/**
 * 剥离源码中的注释，只留可执行代码。
 *
 * 【为什么不能只滤行首】只滤 `*` / `//` 开头的行会漏掉**行内尾随注释**：
 * `const a = 1; // Math.random() 只是注释` 会被当成代码，既可能误报
 * （注释里提到 Math.random 就报红），也可能掩盖真实问题。这里按顺序
 * 处理字符串字面量、块注释、行注释，三种都剥掉。
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  /** @type {string} */
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (two === '//') {
      const end = src.indexOf('\n', i + 2);
      i = end === -1 ? n : end;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      // 字符串字面量整体保留内容但不当代码扫描：跳过到匹配引号
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === ch) break;
        j += 1;
      }
      out += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

test('安全凭证不得有可猜兜底：nonce/launchToken 路径中不出现 Math.random', () => {
  // 只针对**鉴权凭证**文件做静态断言：nonce 与 launchToken 都出自 host-bridge.js。
  // assembler/sdk 里的 sdkInstanceId 只是 iframe 内日志标识，不参与鉴权，不在本断言范围。
  const bridgeSrc = fs.readFileSync(path.resolve(here, '../src/bridge/host-bridge.js'), 'utf8');
  // 先证明剥离函数本身有效（防止哪天它坏了导致断言永远绿）
  assert.equal(stripComments('const a = 1; // Math.random()'), 'const a = 1; ', '行注释必须被剥离');
  assert.equal(stripComments('/* Math.random() */const a = 1'), ' const a = 1', '块注释必须被剥离');
  assert.equal(stripComments("const s = 'Math.random()';"), "const s = 'Math.random()';", '字符串内容必须保留');

  const bridgeCode = stripComments(bridgeSrc);
  assert.ok(
    !bridgeCode.includes('Math.random'),
    'host-bridge.js 的可执行代码中不得出现 Math.random（nonce/launchToken 不得静默降级）',
  );

  // Overlay 的 nonce/launchToken 兜底同样不得用可猜值
  const overlaySrc = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterOverlay.js'), 'utf8');
  const overlayCode = stripComments(overlaySrc);
  const nonceLines = overlayCode
    .split('\n')
    .filter((line) => line.includes('const nonce =') || line.includes('const launchToken'));
  assert.ok(nonceLines.length >= 4, `正式与预览两条路径都必须生成 nonce 与 launchToken，实际 ${nonceLines.length}`);
  for (const line of nonceLines) {
    assert.ok(!line.includes('Math.random'), `凭证生成不得有可猜兜底: ${line.trim()}`);
  }
});

test('launchToken：形状满足协议 isLaunchTokenShapeValid（32~256 位可见 ASCII、无空白）', () => {
  const token = createLaunchToken();
  assert.ok(typeof token === 'string');
  assert.ok(token.length >= 32 && token.length <= 256, `长度必须在 32~256，实际 ${token.length}`);
  // 可见 ASCII（0x21-0x7e），无空白/控制字符
  assert.match(token, /^[\x21-\x7e]+$/);
  // base64url 字符集（当前实现）
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(createLaunchToken(), token, '两次生成必须不同（不可猜）');
});

/**
 * 临时把 `globalThis.crypto` 替换成给定值，返回恢复函数。
 * Node 的 crypto 是只读 getter，必须用 defineProperty 覆盖。
 * @param {any} value
 * @returns {() => void}
 */
function withGlobalCrypto(value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value,
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
  });
  return () => {
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    } else {
      // @ts-expect-error 测试内清理
      delete globalThis.crypto;
    }
  };
}

test('launchToken：无 CSPRNG 时必须抛错，绝不降级到 Math.random', () => {
  const restore = withGlobalCrypto({ getRandomValues: undefined });
  try {
    assert.throws(
      () => createLaunchToken(),
      /CSPRNG/,
      '没有 CSPRNG 时必须抛错，不得降级到可猜的 Math.random',
    );
  } finally {
    restore();
  }
  // 恢复后必须仍能正常生成（验证上面没有污染全局状态）
  assert.match(createLaunchToken(), /^[A-Za-z0-9_-]{32,256}$/);
});

test('launchToken：无 crypto 对象时同样抛错（连 getRandomValues 字段都没有）', () => {
  const restore = withGlobalCrypto(undefined);
  try {
    assert.throws(() => createLaunchToken(), /CSPRNG/);
  } finally {
    restore();
  }
  assert.match(createLaunchToken(), /^[A-Za-z0-9_-]{32,256}$/);
});

test('launchToken：btoa 不可用时退回十六进制，仍满足形状约束', () => {
  const originalBtoa = globalThis.btoa;
  // @ts-expect-error 故意置空
  globalThis.btoa = undefined;
  try {
    const token = createLaunchToken();
    assert.match(token, /^[0-9a-f]{64}$/, '无 btoa 时应退回 64 位十六进制（32 字节）');
  } finally {
    globalThis.btoa = originalBtoa;
  }
});
