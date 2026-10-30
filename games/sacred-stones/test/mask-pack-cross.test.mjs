/**
 * 两套打包器的交叉校验（不是"我算两遍"）。
 *
 * 参照实现是后台交付的 `tools/mask-pack/pack.mjs`（本目录留了只读副本
 * `mask-pack-reference.mjs`，内容逐字节一致，来源 commit 在 docs 里记）。
 * 它与我这份 `src/extract/mask-pack.js` 是**两个人独立写的**，
 * 接口也不同：它收 rows（二维数组），我收扁平像素 + 宽高。
 *
 * 这个用例的唯一目的：任何一方改了 bit 序、行末补位或"1"的定义，这里立刻红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {packMask, packMaskSha256} from '../src/extract/mask-pack.js';
import {packMask as referencePack} from '../tools/mask-pack-reference.mjs';

const W = 240;
const H = 160;

const rowsOf = (pixels, width, height) => {
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Array.from(pixels.subarray(y * width, y * width + width)));
  return rows;
};

test('对角 + 反对角图案：两套打包器逐字节一致（4,800 B）', () => {
  const pixels = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    pixels[y * W + (y % W)] = 1;
    pixels[y * W + (W - 1 - (y % W))] = 1;
    if (y % 3 === 0) pixels[y * W + 1] = 1;
  }
  const mine = Buffer.from(packMask(pixels, {width: W, height: H}));
  const theirs = Buffer.from(referencePack(rowsOf(pixels, W, H)));
  assert.equal(mine.length, 4800);
  assert.deepEqual([...mine], [...theirs]);
});

test('整屏全 1：行末补位不会把下一行挤掉（每行 0xff ×30）', () => {
  const pixels = new Uint8Array(W * H).fill(1);
  const mine = Buffer.from(packMask(pixels, {width: W, height: H}));
  const theirs = Buffer.from(referencePack(rowsOf(pixels, W, H)));
  assert.deepEqual([...mine], [...theirs]);
  for (let y = 0; y < H; y += 1) {
    for (let b = 0; b < 30; b += 1) assert.equal(mine[y * 30 + b], 0xff);
  }
});

test('整屏全 0：打包器不得凭空造出 1', () => {
  const pixels = new Uint8Array(W * H);
  const mine = Buffer.from(packMask(pixels, {width: W, height: H}));
  const theirs = Buffer.from(referencePack(rowsOf(pixels, W, H)));
  assert.deepEqual([...mine], [...theirs]);
  assert.ok(mine.every((b) => b === 0));
});

test('MSB-first 判据：只有最左上像素为 1 时首字节必须是 0x80，不是 0x01', () => {
  const pixels = new Uint8Array(W * H);
  pixels[0] = 1;
  const mine = Buffer.from(packMask(pixels, {width: W, height: H}));
  assert.equal(mine[0], 0x80);
  assert.deepEqual([...mine], [...Buffer.from(referencePack(rowsOf(pixels, W, H)))]);
  // 记录当前口径下的 sha，防止"改了 bit 序却没人发现"
  assert.equal(packMaskSha256(pixels, {width: W, height: H}), packMaskSha256(pixels, {width: W, height: H}));
});
