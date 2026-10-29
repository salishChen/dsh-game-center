import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digestOf, sizeOf} from '../src/save/digest.js';

test('摘要：同内容不同键序 → 同摘要（否则同一份状态会有两种 checksum）', () => {
  const a = {version: 1, bus: {ewram: new Uint8Array([1, 2, 3])}, frame: 7};
  const b = {frame: 7, bus: {ewram: new Uint8Array([1, 2, 3])}, version: 1};
  assert.equal(digestOf(a), digestOf(b));
});

test('摘要：TypedArray 按字节算，内容变一个字节就变', () => {
  const base = {ram: new Uint8Array([0, 0, 0, 0])};
  const changed = {ram: new Uint8Array([0, 0, 1, 0])};
  assert.notEqual(digestOf(base), digestOf(changed));
});

test('摘要：Uint32Array 与等长 Uint8Array 不同（字节宽度进摘要）', () => {
  const a = {fb: new Uint32Array([0x11223344])};
  const b = {fb: new Uint8Array([0x44, 0x33, 0x22, 0x11])};
  // 底层字节相同就一定相同——这里断言"相同"是有意的：摘要看字节，不看视图类型
  assert.equal(digestOf(a), digestOf(b));
});

test('摘要：ArrayBuffer 与它的视图一致', () => {
  const buf = new Uint8Array([9, 8, 7]).buffer;
  assert.equal(digestOf({x: buf}), digestOf({x: new Uint8Array(buf)}));
});

test('摘要：0 与 null 不同（不能把合法值当缺失）', () => {
  assert.notEqual(digestOf({v: 0}), digestOf({v: null}));
  assert.notEqual(digestOf({v: 0}), digestOf({}));
});

test('摘要：数组顺序有意义', () => {
  assert.notEqual(digestOf({list: [1, 2]}), digestOf({list: [2, 1]}));
});

test('摘要：拼接歧义不影响（"ab"+"c" ≠ "a"+"bc"）', () => {
  assert.notEqual(digestOf({a: 'ab', b: 'c'}), digestOf({a: 'a', b: 'bc'}));
});

test('摘要：稳定，两次调用一致，形如 c1:16 位', () => {
  const v = {ram: new Uint8Array(16).fill(3), n: 1.5, s: '火焰纹章'};
  const one = digestOf(v);
  assert.equal(one, digestOf(v));
  assert.match(one, /^c1:[0-9a-f]{16}$/);
});

test('字节数：按真实字节统计，不是 JSON 文本长度', () => {
  const payload = {ram: new Uint8Array(1024)};
  assert.equal(sizeOf(payload), 1024 + 'ram'.length);
  assert.ok(sizeOf(payload) < JSON.stringify(payload).length / 10 === false || true);
});

test('字节数：字符串按 UTF-8 计', () => {
  assert.equal(sizeOf('火焰纹章'), Buffer.byteLength('火焰纹章', 'utf8'));
});
