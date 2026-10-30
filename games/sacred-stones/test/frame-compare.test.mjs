import test from 'node:test';
import assert from 'node:assert/strict';

import {decodePng, encodePng} from '../src/extract/png.js';
import {compareFrames, toNative} from '../scripts/compare-frame.mjs';

const solid = (width, height, [r, g, b, a = 255]) => {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4 + 0] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return {width, height, rgba};
};

test('PNG 往返：编码后再解码，像素逐字节一致', () => {
  const src = solid(4, 3, [12, 200, 7, 128]);
  const back = decodePng(encodePng(src));
  assert.equal(back.width, 4);
  assert.equal(back.height, 3);
  assert.deepEqual([...back.rgba], [...src.rgba]);
});

test('PNG 往返：真实尺寸 240x160 也不失真', () => {
  const src = solid(240, 160, [1, 2, 3]);
  for (let i = 0; i < 240 * 160; i += 1) src.rgba[i * 4 + 0] = i & 0xff;
  const back = decodePng(encodePng(src));
  assert.deepEqual([...back.rgba], [...src.rgba]);
});

test('PNG 拒绝非 PNG 字节，且报的是人话', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /不是 PNG/);
});

test('遇到索引色 PNG：报错必须点名 IHDR 字段和该怎么做', () => {
  // 只有 IHDR 头也足以触发"不支持"，报错信息是给人看的，不是给日志看的
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(240, 0);
  ihdr.writeUInt32BE(160, 4);
  ihdr[8] = 8;
  ihdr[9] = 3; // 索引色
  ihdr[12] = 0;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    length,
    Buffer.from('IHDR', 'ascii'),
    ihdr,
    Buffer.alloc(4),
  ]);
  assert.throws(
    () => decodePng(png),
    (err) => {
      assert.match(err.message, /width=240 height=160 bitDepth=8 colorType=3/, '必须原样打出 IHDR');
      assert.match(err.message, /索引色/, '必须说人话解释 colorType 3');
      assert.match(err.message, /请导出为 24 位 RGB 或 32 位 RGBA/, '必须给出可执行的下一步');
      return true;
    },
  );
});

test('最近邻放大图缩回原生：2x 图的每个像素块取左上角，不是双线性混合', () => {
  const double = solid(480, 320, [0, 0, 0]);
  // 只在 (0,0) 期望红：2x 图里对应 2x2 区块
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      const i = (y * 480 + x) * 4;
      double.rgba[i] = 255;
    }
  }
  const native = toNative(double, 240, 160);
  assert.equal(native.scale, 2);
  assert.deepEqual([...native.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  // 双线性会把边缘混成红色一半；最近邻必须仍是纯黑
  assert.deepEqual([...native.rgba.subarray(4, 8)], [0, 0, 0, 255]);
});

test('非整数倍尺寸直接拒绝，不做"尽力而为"的缩放', () => {
  assert.throws(() => toNative(solid(500, 300, [0, 0, 0]), 240, 160), /整数倍/);
});

test('横纵缩放比不同（被拉伸过）必须拒绝', () => {
  assert.throws(() => toNative(solid(480, 160, [0, 0, 0]), 240, 160), /拉伸/);
});

test('相同两张图：差异 0，退出判据为 0', () => {
  const a = solid(240, 160, [9, 9, 9]);
  const r = compareFrames(a, solid(240, 160, [9, 9, 9]));
  assert.equal(r.diffPixels, 0);
  assert.equal(r.total, 38400);
  assert.equal(r.ratio, 0);
  assert.equal(r.maxChannelDelta, 0);
});

test('一个通道差 1 在容差 1 内算相同，但 maxChannelDelta 仍如实报 1', () => {
  const a = solid(240, 160, [10, 10, 10]);
  const b = solid(240, 160, [11, 10, 10]);
  const r = compareFrames(a, b, {tolerance: 1});
  assert.equal(r.diffPixels, 0);
  assert.equal(r.maxChannelDelta, 1);
});

test('容差 0 时同一点必须红，且报出第一个差异点的两侧原值', () => {
  const a = solid(240, 160, [10, 10, 10]);
  const b = solid(240, 160, [11, 10, 10]);
  const r = compareFrames(a, b, {tolerance: 0});
  assert.equal(r.diffPixels, 38400);
  assert.deepEqual(r.firstDiff.actual, [10, 10, 10, 255]);
  assert.deepEqual(r.firstDiff.expected, [11, 10, 10, 255]);
});

test('区域比较只统计该区域，总像素数是区域面积而不是整屏', () => {
  const a = solid(240, 160, [0, 0, 0]);
  const b = solid(240, 160, [0, 0, 0]);
  // 在区域外改一个像素，区域比较不该看见它
  b.rgba[0] = 255;
  const r = compareFrames(a, b, {tolerance: 0, region: {x: 16, y: 16, width: 32, height: 16}});
  assert.equal(r.total, 32 * 16);
  assert.equal(r.diffPixels, 0);
});

test('区域越界直接抛错，不静默裁掉', () => {
  const a = solid(240, 160, [0, 0, 0]);
  assert.throws(() => compareFrames(a, a, {region: {x: 200, y: 0, width: 100, height: 10}}), /超出/);
});

test('尺寸不一致的比较直接抛错，而不是按小的比', () => {
  assert.throws(() => compareFrames(solid(240, 160, [0, 0, 0]), solid(480, 320, [0, 0, 0])), /尺寸不一致/);
});

test('整屏差一块 16x16：差异像素数必须是 256，占比 0.667%', () => {
  const a = solid(240, 160, [0, 0, 0]);
  const b = solid(240, 160, [0, 0, 0]);
  for (let y = 32; y < 48; y += 1) {
    for (let x = 64; x < 80; x += 1) {
      const i = (y * 240 + x) * 4;
      b.rgba[i] = 200;
    }
  }
  const r = compareFrames(a, b, {tolerance: 0});
  assert.equal(r.diffPixels, 256);
  assert.equal(r.total, 38400);
  assert.equal(Number((r.ratio * 100).toFixed(3)), 0.667);
  assert.deepEqual([r.firstDiff.x, r.firstDiff.y], [64, 32]);
});
