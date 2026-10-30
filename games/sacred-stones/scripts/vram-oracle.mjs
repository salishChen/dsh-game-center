#!/usr/bin/env node
// VRAM 判据：用运行中的游戏当"标准答案"，把 ROM 压缩块和图块数据对上。
//
// 为什么需要它：靠熵/索引分布猜"哪块是图形"，捞出来的全是雪花（第一版挑了
// 2047 个候选，渲染出来一篇噪声）。真正可靠的做法是让游戏自己说——把标题画面
// 的 VRAM 取出来，逐 32 字节做哈希，再回到 ROM 的压缩块里找同样的字节串。
// 一块 255/255 命中，就等于"整块就是标题画面用的图块"，不需要任何启发式。
//
// 用法：node scripts/vram-oracle.mjs [--rom <path>] [--frames 900] [--out <dir>]
// 产物：<out>/vram-match.json、vram-tiles.bin、vram-palette.bin
//
// 依赖：@gba-kit/gba-emulator 只是**参照物**，不参与发布产物（发行版里没有它）。

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Gba, BOOT_STACK_POINTERS} from '@gba-kit/gba-emulator';
import {MODE_SYS} from '@gba-kit/arm-emulator/arm-cpu';
import {decompress} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
const outDir = resolve(argOf('out', join(repoRoot, '.botharness', 'blocks-preview')));
const frames = Number(argOf('frames', '900'));
const listPath = join(here, '..', 'docs', 'block-list-v1.txt');

if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

const rom = new Uint8Array(readFileSync(romPath));
const gba = new Gba();
gba.reset();
gba.loadRom(rom);
const cpu = gba.armCpu;
// 没有 BIOS：我们自己扮演它，否则 PC 恒 0、画面恒黑
for (const [mode, sp] of BOOT_STACK_POINTERS) {
  cpu.switchMode(mode);
  cpu.registers[13] = sp;
}
cpu.switchMode(MODE_SYS);
cpu.cpsr = MODE_SYS;
cpu.registers[15] = 0x08000000;
for (let i = 0; i < frames; i += 1) gba.runFrame();

const snap = gba.serialize();
const vramBytes = Uint8Array.from(snap.bus.vram);
const paletteBytes = Uint8Array.from(snap.bus.palette);

const hash32 = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const uniform = (tile) => {
  for (let i = 1; i < tile.length; i += 1) if (tile[i] !== tile[0]) return false;
  return true;
};

const vramTiles = new Map();
for (let t = 0; t < vramBytes.length / 32; t += 1) {
  const tile = vramBytes.subarray(t * 32, t * 32 + 32);
  if (uniform(tile)) continue;
  vramTiles.set(hash32(tile), t);
}

const rows = readFileSync(listPath, 'utf8')
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [offset, dlen, clen] = line.split('\t').map(Number);
    return {offset, dlen, clen};
  });

const hits = [];
for (const row of rows) {
  const res = decompress(rom, row.offset);
  if (!res) continue;
  const out = res.output;
  let matched = 0;
  let totalTiles = 0;
  for (let off = 0; off + 32 <= out.length; off += 32) {
    const tile = out.subarray(off, off + 32);
    if (uniform(tile)) continue;
    totalTiles += 1;
    if (vramTiles.has(hash32(tile))) matched += 1;
  }
  if (matched > 0) hits.push({offset: row.offset, dlen: out.length, totalTiles, matched});
}

hits.sort((a, b) => b.matched - a.matched);
const summary = {
  frames,
  scope: {
    lowerBoundOnly: true,
    note: '本结果只覆盖这一帧加载进 VRAM 的图形块；未命中不等于不存在（可能这一帧没加载、可能运行时拼装、可能被补丁改过）。要分母必须多状态取并集。',
  },
  vramTilesInVram: vramTiles.size,
  blocksWithHits: hits.length,
  tilesMatchedTotal: hits.reduce((s, h) => s + h.matched, 0),
  top: hits.slice(0, 20),
};

mkdirSync(outDir, {recursive: true});
writeFileSync(join(outDir, 'vram-match.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(outDir, 'vram-tiles.bin'), Buffer.from(vramBytes));
writeFileSync(join(outDir, 'vram-palette.bin'), Buffer.from(paletteBytes));

// --emit-fixture：把「这一帧 VRAM 里出现过的图块哈希」固化成回归夹具。
// 夹具只含哈希、不含像素数据，进仓库无版权问题；测试用它比对解码器输出，
// 谁改了 LZ77/Huffman 语义都会立刻红（不需要每次跑模拟器）。
const fixturePath = argOf('fixture', null);
if (fixturePath) {
  const tiles = [...vramTiles.keys()].sort();
  const fixture = {
    note: `帧 ${frames} 标题画面 VRAM 中非纯色图块的 sha1 前 16 位；由 scripts/vram-oracle.mjs --emit-fixture 生成。未命中不等于不存在。`,
    frames,
    romSha256: readFileSync(join(here, '..', 'src', 'rom-identity.js'), 'utf8').includes('167ed57921c24f84')
      ? '167ed57921c24f841108f46eabc33cb10e10f141b09d0fa6e75b5c5add3e4df0'
      : 'unknown',
    tileCount: tiles.length,
    tiles,
  };
  writeFileSync(resolve(fixturePath), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`fixture → ${resolve(fixturePath)}（${tiles.length} 个图块哈希）`);
}

console.log(JSON.stringify(summary, null, 2));
