#!/usr/bin/env node
// 把压缩块解出来并做粗分类，产物放到 .botharness/blocks/ 供渲染核对（不进仓库）。
//
// 分类只是**排序线索**，不是结论：真正的判据是渲染出来能不能认出来。
// 用法：node scripts/dump-blocks.mjs [--rom <path>] [--out <.botharness/blocks>]

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decompress} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
const outDir = resolve(argOf('out', join(repoRoot, '.botharness', 'blocks')));
const listPath = join(here, '..', 'docs', 'block-list-v1.txt');

if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

const rom = readFileSync(romPath);
const rows = readFileSync(listPath, 'utf8')
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [offset, dlen, clen] = line.split('\t').map(Number);
    return {offset, dlen, clen};
  });

mkdirSync(outDir, {recursive: true});

// ---- 特征 ----------------------------------------------------------------
function entropy(buf) {
  const counts = new Uint32Array(256);
  for (const b of buf) counts[b] += 1;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function paletteScore(buf) {
  if (buf.length < 32 || buf.length % 32 !== 0) return 0;
  const colors = new Set();
  let highBits = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = buf[i] | (buf[i + 1] << 8);
    if (v & 0x8000) highBits += 1;
    colors.add(v);
  }
  if (highBits > 0) return 0; // GBA 调色板不用最高位
  if (colors.size < 4) return 0;
  return Math.min(1, colors.size / 256);
}

// 4bpp 图块的分布特征。**熵不能当判据**：噪声恰好高熵且索引均匀，
// 第一版用「高熵 + 多索引」打分，捞出 2047 个候选，渲染出来全是雪花。
// 真正拉开差距的是这两个：
//   ① 索引 0（背景/透明）的占比：图块通常 30%~85%，噪声恒定在 6.25% 附近；
//   ② 相邻像素取值变化率（flatness）：图块每个字节内两个半字节常相同、
//      行内也有大片同色，噪声几乎每个像素都在跳。
function gfx4bppScore(buf, features) {
  if (buf.length < 1024 || buf.length % 32 !== 0) return 0;
  const {zero, used, flatness} = features;
  if (zero < 0.3 || zero > 0.85) return 0;
  if (used < 6) return 0;
  if (flatness > 0.35) return 0;
  return Number(((1 - flatness) * Math.min(1, used / 10)).toFixed(3));
}

function nibbleStats(buf) {
  const counts = new Array(16).fill(0);
  for (const b of buf) {
    counts[b >> 4] += 1;
    counts[b & 0x0f] += 1;
  }
  const total = buf.length * 2;
  const zero = counts[0] / total;
  const used = counts.filter((c) => c / total > 0.01).length;
  let changes = 0;
  for (let i = 1; i < buf.length; i += 1) {
    if ((buf[i] >> 4) !== (buf[i - 1] & 0x0f)) changes += 1;
  }
  return {zero: Number(zero.toFixed(4)), used, flatness: Number((changes / buf.length).toFixed(4))};
}

function textScore(buf) {
  // 汉化文本：GB2312 双字节 + ASCII 可打印；这里只做粗筛
  let printable = 0;
  for (const b of buf) {
    if (b === 0x00 || (b >= 0x20 && b < 0x7f) || b >= 0x80) printable += 1;
  }
  return printable / buf.length;
}

const catalog = [];
for (const row of rows) {
  const result = decompress(rom, row.offset);
  if (!result) continue;
  const buf = result.output;
  const ns = nibbleStats(buf);
  const features = {
    offset: row.offset,
    clen: result.consumed,
    dlen: buf.length,
    entropy: Number(entropy(buf).toFixed(4)),
    zero: ns.zero,
    used: ns.used,
    flatness: ns.flatness,
    palette: Number(paletteScore(buf).toFixed(3)),
    gfx4: gfx4bppScore(buf, ns),
    text: Number(textScore(buf).toFixed(3)),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
  catalog.push(features);
  // 只落"有图形或调色板嫌疑"的块，避免 4,425 个文件
  if (features.gfx4 > 0 || features.palette >= 0.25) {
    writeFileSync(join(outDir, `${row.offset}.bin`), buf);
  }
}

writeFileSync(join(outDir, 'catalog.json'), `${JSON.stringify(catalog, null, 0)}\n`);

const topGfx = [...catalog].sort((a, b) => b.gfx4 - a.gfx4).slice(0, 15);
const topPal = [...catalog].sort((a, b) => b.palette - a.palette).slice(0, 10);
const counts = {
  total: catalog.length,
  gfx4_candidates: catalog.filter((c) => c.gfx4 > 0).length,
  palette_candidates: catalog.filter((c) => c.palette >= 0.25).length,
  text_candidates: catalog.filter((c) => c.text > 0.95 && c.gfx4 === 0).length,
};
console.log(JSON.stringify({counts, topGfx, topPal}, null, 2));
