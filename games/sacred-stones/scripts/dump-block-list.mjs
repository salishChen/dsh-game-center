#!/usr/bin/env node
// 导出「指针枚举出的压缩块」清单，供双方做集合差（PM 要求：计数相等不是收敛，集合相等才是）。
//
// 用法：
//   node scripts/dump-block-list.mjs <rom.gba> [--out docs/block-list-v1.txt]
//
// 输出格式：以 `#` 开头的头注说明口径与来源，其余每行 `offset<TAB>dlen<TAB>clen`，
// 按 offset 升序（十进制 offset 排序即字节序，便于 comm 比较前再 sort -k1,1）。
// 只写已被本脚本**判定通过**的块；被闸门排除的不出现在清单里，差异靠集合差定位。

import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {
  collectRomPointers,
  formatOf,
  isPlausibleBlockOffset,
  decompress,
  FORMAT_MAX_RATIO,
  BLOCK_MIN_SIZE,
  BLOCK_MAX_SIZE,
  ROM_POINTER_BASE,
} from '../src/extract/bios-decompress.js';

const FORMAT_NAMES = {0x10: 'lz77', 0x20: 'huffman', 0x30: 'rle'};

function parseArgs(argv) {
  const args = {rom: null, out: null};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (!args.rom) {
      args.rom = a;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.rom) {
  console.error('用法: node scripts/dump-block-list.mjs <rom.gba> [--out <file>]');
  process.exit(2);
}

const bytes = readFileSync(resolve(args.rom));
const romSha256 = createHash('sha256').update(bytes).digest('hex');
const pointers = collectRomPointers(bytes);

const rows = [];
const excluded = {implausible: 0, noFormat: 0, decodeFailed: 0, ratioFailed: 0};

for (const offset of pointers) {
  if (!isPlausibleBlockOffset(bytes, offset)) {
    excluded.implausible += 1;
    continue;
  }
  const format = formatOf(bytes, offset);
  if (!FORMAT_NAMES[format]) {
    excluded.noFormat += 1;
    continue;
  }
  const result = decompress(bytes, offset);
  if (result === null || result.consumed <= 0) {
    excluded.decodeFailed += 1;
    continue;
  }
  if (result.output.length / result.consumed > FORMAT_MAX_RATIO[format]) {
    excluded.ratioFailed += 1;
    continue;
  }
  rows.push({offset, dlen: result.output.length, clen: result.consumed, format});
}

rows.sort((a, b) => a.offset - b.offset);

const lines = [];
lines.push('# sacred-stones 压缩块清单（指针枚举口径，游戏实现侧）');
lines.push(`# rom_sha256=${romSha256}`);
lines.push(`# rom_bytes=${bytes.length}`);
lines.push('# 生成器=games/sacred-stones/scripts/dump-block-list.mjs');
lines.push('#');
lines.push('# 本文件的口径（对方须逐条确认或给出相反取值）：');
lines.push('# 1. dlen：精确相等（解出长度必须等于头部声明的 dlen，任何剩余都算失败）；');
lines.push('# 2. 指针：任意偏移（不要求 4 字节对齐），但块起始 offset 必须落在 [0, rom-4)；');
lines.push('# 3. 边界：指针值 v 的换算为 offset = v - 0x08000000，要求 offset + 4 <= rom bytes；');
lines.push(`# 4. 附加闸门：块长度 >= ${BLOCK_MIN_SIZE}、<= ${BLOCK_MAX_SIZE}（0x${BLOCK_MAX_SIZE.toString(16)}）；`);
lines.push(`#    压缩比上限 lz77<=${FORMAT_MAX_RATIO[0x10]} huffman<=${FORMAT_MAX_RATIO[0x20]} rle<=${FORMAT_MAX_RATIO[0x30]}；`);
lines.push('# 以上 4 条是我们与逆向那 35 块差异的全部可能来源，逐块可指名。');
lines.push('#');
lines.push('# 范围声明：本清单只包含通过校验的 LZ77 块。Huffman 树尚未校准、RLE 无通过块，');
lines.push('# 因此这不是「全部压缩块」清单，不得被当作资产总数的依据。');
lines.push('#');
lines.push(`# 指针总数=${pointers.length}`);
lines.push(`# 排除：疑似块头不成立=${excluded.implausible} 未知格式=${excluded.noFormat} 解码失败=${excluded.decodeFailed} 压缩比越界=${excluded.ratioFailed}`);
const byFormat = rows.reduce((acc, r) => {
  acc[r.format] = (acc[r.format] ?? 0) + 1;
  return acc;
}, {});
lines.push(
  `# 通过：total=${rows.length} lz77=${byFormat[0x10] ?? 0} huffman=${byFormat[0x20] ?? 0} rle=${byFormat[0x30] ?? 0}`,
);
lines.push(`# 列：offset<TAB>dlen<TAB>clen（十进制，按 offset 升序），共 ${rows.length} 行`);
for (const r of rows) lines.push(`${r.offset}\t${r.dlen}\t${r.clen}`);

const text = `${lines.join('\n')}\n`;
if (args.out) {
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), {recursive: true});
  writeFileSync(outPath, text, 'utf8');
  console.error(`写入 ${outPath}（${rows.length} 行）`);
} else {
  process.stdout.write(text);
}
