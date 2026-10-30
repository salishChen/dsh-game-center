#!/usr/bin/env node
// 压缩比上限的标定：阈值必须由**假阳性分布**定，不能由"我想让哪几块进来"定。
//
// 做法：把 ROM 字节用固定种子打乱（真块的结构就没了，只剩"随机字节碰巧长得像
// 压缩块头"），再跑同一套枚举与解码，量出假阳性的 dlen/clen 分布。
// 阈值应当取在"假阳性上界"之上留余量，而不是取在"真块下界"之上。
//
// 用法：node scripts/ratio-calibration.mjs [--rom <path>] [--seed 20261030]

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FORMAT_LZ77, scanPointedBlocks} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
const seed = Number(argOf('seed', '20261030'));
if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

/** xorshift32：种子固定 ⇒ 结果可复现，不用 Math.random。 */
function makeRandom(seedValue) {
  let state = seedValue >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

const rom = new Uint8Array(readFileSync(romPath));
const random = makeRandom(seed);
const shuffled = Uint8Array.from(rom);
for (let i = shuffled.length - 1; i > 0; i -= 1) {
  const j = random() % (i + 1);
  const t = shuffled[i];
  shuffled[i] = shuffled[j];
  shuffled[j] = t;
}

const stat = (values) => {
  if (!values.length) return {count: 0};
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return {
    count: values.length,
    min: +sorted[0].toFixed(3),
    median: +at(0.5).toFixed(3),
    p99: +at(0.99).toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(3),
  };
};

const scan = (bytes, label) => {
  // 只关压缩比闸门，其余闸门（指针引用 / dlen 区间 / dlen 精确）保持不变，
  // 否则量到的就不是"同一判据下的假阳性"了。
  const result = scanPointedBlocks(bytes, {maxRatio: {[FORMAT_LZ77]: Number.POSITIVE_INFINITY}});
  const ratios = result.blocks.filter((b) => b.format === FORMAT_LZ77).map((b) => b.dlen / b.clen);
  return {label, blocks: result.blocks.filter((b) => b.format === FORMAT_LZ77).length, ratios: stat(ratios)};
};

const real = scan(rom, 'real');
const fake = scan(shuffled, `shuffled(seed=${seed})`);
console.log(JSON.stringify({rom: romPath, seed, real, fake}, null, 2));
