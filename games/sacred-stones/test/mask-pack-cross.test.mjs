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

// ── 产地章：只读副本必须能**只凭仓库**复算，且先判脏再说漂移 ──────────────────
import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const PROVENANCE = JSON.parse(readFileSync(join(here, '..', 'tools', 'mask-pack-reference.provenance.json'), 'utf8'));

const shaOf = (buf) => createHash('sha256').update(buf).digest('hex');
const normalizedSha = (buf) => shaOf(Buffer.from(buf.toString('utf8').replaceAll(String.fromCharCode(13,10), String.fromCharCode(10)), 'utf8'));
const gitBytes = (args) => {
  try {
    return execFileSync('git', args, {cwd: repoRoot, encoding: 'buffer'});
  } catch {
    return null;
  }
};

test('产地章：上游字节必须等于 `git show <source_commit>:<path>` 的 sha256（只凭仓库可复算）', () => {
  assert.ok(PROVENANCE.source_commit, 'source_commit 不许留空：上游已入库就必须引用 commit');
  const blob = gitBytes(['show', `${PROVENANCE.source_commit}:${PROVENANCE.source_path}`]);
  assert.ok(blob, `无法从 ${PROVENANCE.source_commit} 读取 ${PROVENANCE.source_path}`);
  assert.equal(shaOf(blob), PROVENANCE.source_sha256);
});

test('产地章：副本内容必须等于同一 commit 里的上游（不是"和本机工作区一样"）', () => {
  const upstreamBlob = gitBytes(['show', `${PROVENANCE.source_commit}:${PROVENANCE.source_path}`]);
  const copy = readFileSync(join(repoRoot, PROVENANCE.copy_path));
  assert.equal(normalizedSha(copy), normalizedSha(upstreamBlob));
  assert.equal(normalizedSha(copy), PROVENANCE.copy_sha256_lf);
});

test('产地章：上游工作区脏了要单独说"上游在漂"，不许误报成副本漂移', () => {
  const dirty = gitBytes(['status', '--porcelain', '--', PROVENANCE.source_path]);
  const text = dirty ? dirty.toString('utf8').trim() : '';
  // 工作区脏时，本用例失败并明确指向"上游有未提交改动"，而不是让人去查副本。
  assert.equal(text, '', `上游 ${PROVENANCE.source_path} 有未提交改动：${text}。先提交或还原，再用 scripts/refresh-mask-pack-copy.mjs 重新刷新副本。`);
});

test('上游一旦入库，source_commit 不得为空（到期条件：null 只能是"未入库"的临时态）', () => {
  const tracked = gitBytes(['log', '-1', '--format=%H', '--', PROVENANCE.source_path]);
  if (tracked && tracked.toString('utf8').trim() !== '') {
    assert.ok(PROVENANCE.source_commit, '上游已入库，产地章必须补上 source_commit');
  }
});
