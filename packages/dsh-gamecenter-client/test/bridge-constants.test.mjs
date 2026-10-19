/**
 * 契约同源断言：Client 包在浏览器里不能 import workspace 协议包，因此少量
 * 常量在 src/bridge/host-bridge.js 做了本地镜像。此测试保证镜像与
 * packages/protocol/dist/index.js 完全一致，任何单方面改动都会失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_METHODS as CLIENT_METHODS,
  BRIDGE_MAX_MESSAGE_BYTES as CLIENT_MAX_BYTES,
  utf8ByteLength as clientUtf8ByteLength,
} from '../src/bridge/host-bridge.js';
import { BRIDGE_METHODS as PROTOCOL_METHODS, BRIDGE_MAX_MESSAGE_BYTES as PROTOCOL_MAX_BYTES, utf8ByteLength as protocolUtf8ByteLength } from '../../protocol/dist/index.js';

test('Bridge 方法白名单与协议包同源（顺序也一致）', () => {
  assert.deepEqual([...CLIENT_METHODS], [...PROTOCOL_METHODS]);
});

test('Bridge 消息大小上限与协议包同源', () => {
  assert.equal(CLIENT_MAX_BYTES, PROTOCOL_MAX_BYTES);
});

test('UTF-8 字节数计算与协议包一致（含中文与 emoji）', () => {
  for (const sample of ['', 'abc', '游戏中心', '🎮 小游戏', 'a\u0000b']) {
    assert.equal(clientUtf8ByteLength(sample), protocolUtf8ByteLength(sample), `差异化样本: ${sample}`);
  }
});
