#!/usr/bin/env node
// 导出「我这边接受的压缩块清单」，供跨实现做集合差。
//
// 为什么要有这个脚本：跨实现比对时最贵的不是算法，而是"两边说的 4,425 / 4,460
// 到底差在哪一行判据"。所以清单必须自带三样东西，否则别人无法复算：
//   * rom_sha256      —— 比错文件时，差集会伪装成"解码器不一致"
//   * 生成器/解码器 sha256 —— 分清"数据变了"还是"工具变了"
//   * 三道闸门的取值    —— 数字是输出的，闸门才是判据
//
// 用法：
//   node scripts/export-block-list.mjs [--rom <path>] [--out <tsv>]
//
// 输出格式（与逆向那边一致）：offset<TAB>dlen<TAB>clen，按 offset 升序。
// 脚本自检：写完后重读文件、数数据行，与内存中的条数不一致就以非零退出。

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  BLOCK_MIN_SIZE,
  BLOCK_MAX_SIZE,
  FORMAT_MAX_RATIO,
  FORMAT_LZ77,
  ROM_POINTER_BASE,
  scanPointedBlocks,
} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
const outPath = resolve(argOf('out', join(here, '..', 'extract', 'lz77-pointers-4425.tsv')));
const decoderPath = join(here, '..', 'src', 'extract', 'bios-decompress.js');

if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rom = new Uint8Array(readFileSync(romPath));
const romSha = sha256(rom);
const generatorSha = sha256(new Uint8Array(readFileSync(fileURLToPath(import.meta.url))));
const decoderSha = sha256(new Uint8Array(readFileSync(decoderPath)));

const scan = scanPointedBlocks(rom);
const accepted = scan.blocks
  .filter((b) => b.format === FORMAT_LZ77)
  .sort((a, b) => a.offset - b.offset);

const lines = accepted.map((b) => `${b.offset}\t${b.dlen}\t${b.clen}`);
const header = [
  '# 圣魔之光石（汉化镜像）LZ77 压缩块清单 —— 游戏实现侧口径',
  // 头注用 key=value：比较器（以及任何按行解析的工具）只认这个格式。
  // 写成 `# key	value` 会被判成"缺 rom_sha256"，于是闸门静默失效——
  // 闸门失效比闸门报错危险得多。
  `# rom_sha256=${romSha}`,
  '# generator=scripts/export-block-list.mjs',
  `# generator_sha256=${generatorSha}`,
  '# decoder=src/extract/bios-decompress.js',
  `# decoder_sha256=${decoderSha}`,
  '# columns=offset_decimal,dlen,clen',
  '# sort=offset_ascending',
  `# rows=${lines.length}`,
  '# gates（全部写死，不用"按需"）',
  `# gate.pointer_base=0x${ROM_POINTER_BASE.toString(16)}`,
  '# gate.pointer_alignment=4',
  `# gate.block_min_size=${BLOCK_MIN_SIZE}`,
  `# gate.block_max_size=0x${BLOCK_MAX_SIZE.toString(16)}`,
  `# gate.max_ratio=${FORMAT_MAX_RATIO[FORMAT_LZ77]}`,
  '# gate.max_ratio_predicate=dlen > max_ratio * clen 时剔除（即 dlen/clen 上限）',
  '# gate.header=first_byte_high_nibble_0x1',
  '# gate.dlen_semantics=解压后精确长度（必须恰好产出 dlen 字节）',
  '# gate.self_overlap=allowed',
  '# gate.same_offset=dedup',
  '# reproduce=node scripts/export-block-list.mjs',
];

mkdirSync(dirname(outPath), {recursive: true});
writeFileSync(outPath, `${[...header, ...lines].join('\n')}\n`);

// 自检：重读文件、数数据行（不以 # 开头），与内存条数必须一致。
const reread = readFileSync(outPath, 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));
if (reread.length !== lines.length) {
  console.error(`自检失败：写入 ${lines.length} 行，重读 ${reread.length} 行`);
  process.exit(1);
}
console.log(`写出 ${outPath}`);
console.log(`rows ${lines.length}`);
console.log(`rom_sha256 ${romSha}`);
console.log(`generator_sha256 ${generatorSha}`);
console.log(`decoder_sha256 ${decoderSha}`);
const sumDlen = accepted.reduce((n, b) => n + b.dlen, 0);
const sumClen = accepted.reduce((n, b) => n + b.clen, 0);
console.log(`dlen 合计 ${sumDlen} / clen 合计 ${sumClen} / 比 ${(sumDlen / sumClen).toFixed(4)}`);
