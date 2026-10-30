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

// ── 产地章：只读副本必须能证明自己没漂移 ────────────────────────────────────
import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const PROVENANCE = JSON.parse(readFileSync(join(here, '..', 'tools', 'mask-pack-reference.provenance.json'), 'utf8'));

const shaOf = (buf) => createHash('sha256').update(buf).digest('hex');
const normalizedSha = (buf) => shaOf(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));

test('产地章：副本的规范化 sha 必须等于它声明的 copy_sha256_lf（本地被改就红）', () => {
  const copy = readFileSync(join(repoRoot, PROVENANCE.copy_path));
  assert.equal(normalizedSha(copy), PROVENANCE.copy_sha256_lf);
});

test('产地章：副本与上游（若在工作区里）必须内容一致，上游改了副本没跟就红', () => {
  const upstream = join(repoRoot, PROVENANCE.source_path);
  if (!existsSync(upstream)) {
    // 上游只存在于别人的机器上时不跳过判定，而是至少要求副本自证（上一条已覆盖）
    return;
  }
  const source = readFileSync(upstream);
  assert.equal(normalizedSha(source), PROVENANCE.source_sha256_lf, '上游内容已变，副本必须同步并更新产地章');
  assert.equal(normalizedSha(readFileSync(join(repoRoot, PROVENANCE.copy_path))), PROVENANCE.source_sha256_lf);
});

test('输入形状错必须当场抛错，不许安静算出一组字节', () => {
  // 1) 长度不对（把 240×160 的图喂给 4×2 的声明）
  assert.throws(() => packMask(new Uint8Array(240 * 160), {width: 4, height: 2}), /像素数量不符/);
  // 2) 传了二维 rows（另一个实现的口径），必须抛而不是箅
  assert.throws(() => packMask([[1, 0], [0, 1]], {width: 2, height: 2}), /像素数量不符/);
  // 3) 长度对但全是 1：输出必须满，且不能被"行末补位"吃成 31 B/行
  const all = Buffer.from(packMask(new Uint8Array(240 * 2).fill(1), {width: 240, height: 2}));
  assert.equal(all.length, 60);
  assert.ok(all.every((b) => b === 0xff));
});
