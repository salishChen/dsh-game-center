/**
 * 文本块候选筛选（**只出 witness，不下结论**）。
 *
 * 为什么只出 witness：本项目在资产分类上已经栽过四轮（熵、零半字节、1bpp/2bpp、4bpp 灰度），
 * 每次都是"打分公式看起来对，渲染出来是雪花"。在没有 ground truth 的情况下，
 * 任何打分只能在**已经知道答案的样本**上验证过才有意义。
 *
 * 所以这个脚本只做两件事：
 *   ① 把可判定的结构信号数出来（控制码出现情况、字节多样性、结尾形态）；
 *   ② 打印 Top N 候选的十六进制，让人（或带真值的对撞方）一眼看出像不像文本。
 *
 * 用法：
 *   node scripts/text-blocks-witness.mjs [--top 5] [--min-dlen 32]
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

import {lz77Decompress, FORMAT_LZ77, collectRomPointers, scanPointedBlocks} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(root, '.botharness-text');

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? process.argv[at + 1] : fallback;
};
const TOP = Number(argOf('top', 5));
const MIN_DLEN = Number(argOf('min-dlen', 32));
const ROM_PATH = process.env.FE8_ROM ?? 'C:/Users/salis/Desktop/dsh-game-boy/artifacts/fe8-remake/fe8-zh.gba';

const rom = new Uint8Array(readFileSync(ROM_PATH));
const scan = scanPointedBlocks(rom, {offsets: collectRomPointers(rom)});

const blocks = [];
for (const block of scan.blocks) {
  if (block.dlen < MIN_DLEN) continue;
  const decoded = lz77Decompress(rom, block.offset);
  if (!decoded || !decoded.output) continue;
  const plain = decoded.output;
  blocks.push({offset: block.offset, dlen: plain.length, clen: block.clen, plain});
}

const stats = blocks.map(({offset, dlen, clen, plain}) => {
  const hist = new Uint32Array(256);
  for (const b of plain) hist[b] += 1;
  let distinct = 0;
  for (let i = 0; i < 256; i += 1) if (hist[i]) distinct += 1;
  let maxShare = 0;
  for (let i = 0; i < 256; i += 1) if (hist[i] > maxShare) maxShare = hist[i];

  // 结构信号（都不是"这是文本"的证明，只是可数的事实）
  let ctrl0A = 0;
  let ctrl0B = 0;
  let zero = 0;
  for (const b of plain) {
    if (b === 0x0a) ctrl0A += 1;
    if (b === 0x0b) ctrl0B += 1;
    if (b === 0x00) zero += 1;
  }
  const printable = hist.slice(0x20, 0x7f).reduce((a, b) => a + b, 0);
  return {
    offset,
    dlen,
    clen,
    distinct,
    maxShare: Number((maxShare / plain.length).toFixed(4)),
    ctrl0A,
    ctrl0B,
    zeroShare: Number((zero / plain.length).toFixed(4)),
    asciiShare: Number((printable / plain.length).toFixed(4)),
    endsWithZero: plain[plain.length - 1] === 0x00,
    plain,
  };
});

// 打分只用来排序候选，**不作为判据**：先控制码密度，再字节集中度。
const scored = stats
  .map((s) => ({
    ...s,
    score: Number((
      Math.min(1, (s.ctrl0A + s.ctrl0B) / 4) * 0.5 +
      Math.min(1, s.maxShare) * 0.3 +
      (s.endsWithZero ? 0.2 : 0)
    ).toFixed(4)),
  }))
  .sort((a, b) => b.score - a.score || a.offset - b.offset);

const hex = (bytes, limit = 64) => {
  const shown = bytes.subarray(0, limit);
  const parts = [];
  for (let i = 0; i < shown.length; i += 16) {
    const row = shown.subarray(i, i + 16);
    const cells = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    parts.push(`${i.toString(16).padStart(4, '0')}  ${cells.padEnd(47)}  ${ascii}`);
  }
  return parts.join('\n');
};

mkdirSync(OUT, {recursive: true});
const top = scored.slice(0, TOP).map((s) => ({
  offset: s.offset,
  offsetHex: `0x${s.offset.toString(16).toUpperCase()}`,
  dlen: s.dlen,
  clen: s.clen,
  score: s.score,
  distinct: s.distinct,
  maxShare: s.maxShare,
  ctrl0A: s.ctrl0A,
  ctrl0B: s.ctrl0B,
  zeroShare: s.zeroShare,
  asciiShare: s.asciiShare,
  endsWithZero: s.endsWithZero,
  plainSha256: createHash('sha256').update(s.plain).digest('hex'),
  head: hex(s.plain, 64),
}));

const summary = {
  rom_sha256: createHash('sha256').update(rom).digest('hex'),
  generator: 'scripts/text-blocks-witness.mjs',
  candidatesTotal: blocks.length,
  minDlen: MIN_DLEN,
  distributions: {
    withCtrl0A: stats.filter((s) => s.ctrl0A > 0).length,
    withCtrl0B: stats.filter((s) => s.ctrl0B > 0).length,
    endsWithZero: stats.filter((s) => s.endsWithZero).length,
    maxShareOver50: stats.filter((s) => s.maxShare > 0.5).length,
  },
  note: '这些是数出来的事实，不是"文本块"的判据；要判定必须拿带真值的样本对撞。',
  top,
};

writeFileSync(join(OUT, 'text-witness.json'), `${JSON.stringify(summary, null, 2)}\n`);

console.log(JSON.stringify({...summary, top: top.map((t) => ({...t, head: undefined}))}, null, 2));
for (const t of top) {
  console.log(`\n${t.offsetHex}  dlen ${t.dlen}  clen ${t.clen}  ctrl0A ${t.ctrl0A}  ctrl0B ${t.ctrl0B}  maxShare ${t.maxShare}`);
  console.log(t.head);
}
