#!/usr/bin/env node
// 把「对方有、我没有」的块逐条归因到"哪一道闸门挡住了它"。
//
// 为什么不能只报总数：三道闸门会在同一块上重叠。一块"非 4 字节对齐 + dlen<32 +
// 没有指针引用"的块同时被三条挡，链式扣减会把它算三次，于是"闸门差异 500 块"
// 这种结论能凭空长出来。所以必须做**集合划分**：每块打上它违反的全部标签，
// 再看八个桶的分布。只有一个桶值得追：标签为空的那个 —— 它在我全部闸门之下
// 依然成立、却仍不在我的清单里，那才是"两边对同一份字节有不同判断"。
//
// 用法：
//   node scripts/attribute-only-blocks.mjs --list <.botharness/block-diff/only-B.txt> [--rom <path>]

import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  BLOCK_MIN_SIZE,
  BLOCK_MAX_SIZE,
  FORMAT_MAX_RATIO,
  FORMAT_LZ77,
  collectRomPointers,
  decompress,
  formatOf,
} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const listPath = resolve(argOf('list', join(repoRoot, '.botharness', 'block-diff', 'only-B.txt')));
const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
if (!existsSync(listPath)) {
  console.error(`找不到清单：${listPath}`);
  process.exit(2);
}
if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

const rom = new Uint8Array(readFileSync(romPath));
const romSha = createHash('sha256').update(rom).digest('hex');
const pointerSet = new Set(collectRomPointers(rom));

const rows = readFileSync(listPath, 'utf8')
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => line.split('\t').map(Number))
  .filter((cols) => cols.length >= 3 && cols.every(Number.isFinite))
  .map(([offset, dlen, clen]) => ({offset, dlen, clen}));

const declaredSize = (offset) => {
  const size = rom[offset + 1] | (rom[offset + 2] << 8) | (rom[offset + 3] << 16);
  return size;
};

const buckets = new Map();
const details = [];
for (const row of rows) {
  const tags = [];
  if (row.offset % 4 !== 0) tags.push('align');
  if (!pointerSet.has(row.offset)) tags.push('pointer');
  const size = declaredSize(row.offset);
  if (size < BLOCK_MIN_SIZE || size > BLOCK_MAX_SIZE) tags.push('size');
  if (row.dlen > FORMAT_MAX_RATIO[FORMAT_LZ77] * row.clen) tags.push('ratio');
  const fmt = formatOf(rom, row.offset);
  if (fmt !== FORMAT_LZ77) tags.push('header');
  else if (decompress(rom, row.offset) === null) tags.push('decode');

  const key = tags.length ? tags.join('+') : '[]';
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(row.offset);
  details.push({...row, tags, declaredSize: size});
}

const summary = {
  romSha256: romSha,
  listPath,
  rows: rows.length,
  gates: {
    pointerAlignment: 4,
    blockMinSize: BLOCK_MIN_SIZE,
    blockMaxSize: BLOCK_MAX_SIZE,
    maxRatio: FORMAT_MAX_RATIO[FORMAT_LZ77],
    maxRatioPredicate: 'dlen > maxRatio * clen 时剔除',
    requiresPointerReference: true,
  },
  buckets: Object.fromEntries(
    [...buckets.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, offsets]) => [key, {count: offsets.length, offsets}]),
  ),
  residual: '标签为 [] 的桶才是真正需要解释的：它过了我全部闸门，却不在我的清单里',
};
const outDir = join(repoRoot, '.botharness', 'block-attr');
mkdirSync(outDir, {recursive: true});
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(
  join(outDir, 'details.tsv'),
  `${['offset', 'dlen', 'clen', 'declaredSize', 'tags'].join('\t')}\n`
  + `${details.map((d) => [d.offset, d.dlen, d.clen, d.declaredSize, d.tags.join(',') || '-'].join('\t')).join('\n')}\n`,
);
console.log(JSON.stringify({rows: summary.rows, buckets: Object.fromEntries(Object.entries(summary.buckets).map(([k, v]) => [k, v.count]))}, null, 2));
