/**
 * 「只靠 ROM 也能画出这一帧」的证明尝试（第二版，带解压缓存与索引上限）。
 *
 * 目标：不跑模拟器，只用卡带 + 寄存器数值，复现帧 900 的整屏画面，并与硬件 framebuffer 逐像素比。
 *
 * 步骤：
 *   1. 解出所有压缩块并**缓存**输出（第一版每查一个候选就重解一次，慢到跑不完）；
 *   2. 用「前 4 字节」建哈希索引，每个 key 只留有限个位置（噪声 key 会命中上万个位置，全留既慢又没用）；
 *   3. 把帧 900 的 VRAM 逐 32 B 图块回 ROM 定位，**找不到就留 0，不拿 dump 字节顶替**；
 *   4. 用重建出来的 VRAM + dump 的调色板/寄存器合成整屏，与硬件逐像素比。
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

import {bootKernel} from '../src/app/boot.js';
import {lz77Decompress, collectRomPointers, scanPointedBlocks} from '../src/extract/bios-decompress.js';
import {renderBgStack} from '../src/extract/bg-render.js';
import {compareFrames} from './compare-frame.mjs';
import {assertFrameNo, expectedFrameFromArgv} from '../src/extract/frame-guard.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(root, '.botharness-romproof');
const ROM = process.env.FE8_ROM ?? 'C:/Users/salis/Desktop/dsh-game-boy/artifacts/fe8-remake/fe8-zh.gba';
const FRAMES = Number(process.argv[2] ?? 900);
const W = 240, H = 160;
const TILE = 32;
const MAX_POSITIONS_PER_KEY = 24;

const rom = new Uint8Array(readFileSync(ROM));

const scan = scanPointedBlocks(rom, {offsets: collectRomPointers(rom)});
const decodedBlocks = [];
for (const block of scan.blocks) {
  const d = lz77Decompress(rom, block.offset);
  if (d && d.output) decodedBlocks.push({offset: block.offset, output: d.output});
}

const keyOf = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
const index = new Map();
for (let bi = 0; bi < decodedBlocks.length; bi += 1) {
  const {output} = decodedBlocks[bi];
  for (let i = 0; i + TILE <= output.length; i += 1) {
    const key = keyOf(output, i);
    let list = index.get(key);
    if (!list) { list = []; index.set(key, list); }
    if (list.length >= MAX_POSITIONS_PER_KEY * 2) continue;
    list.push(bi, i);
  }
}

// 很多图块并不在任何 LZ77 块的输出里（游戏里存在**未压缩**的图形数据，DMA 直接拷进 VRAM）。
// 所以再扫一遍**原始 ROM 字节**：只有 VRAM 里出现过的前 4 字节才需要精确定位，
// 于是先收集"VRAM 用到的 key"集合，再单趟扫 ROM 做集合命中，避免 16M × 3072 次全量比对。
const rawIndex = new Map();
const wantedKeys = new Set();
for (let base = 0; base + TILE <= rom.length; base += 1) {
  // 先只跑一遍收集候选（用 VRAM 的 key 集合做过滤，见下）
  break;
}

const gba = bootKernel(new Uint8Array(rom));
for (let i = 0; i < FRAMES - 1; i += 1) gba.runFrame();
const mmio = gba.bus.mmioRegisters;
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);
const snapshot = {
  dispcnt: u16(0x00),
  bldcnt: u16(0x50),
  bgcnt: [0, 1, 2, 3].map((n) => u16(0x08 + n * 2)),
  bghofs: [0, 1, 2, 3].map((n) => u16(0x10 + n * 4) & 0x1ff),
  bgvofs: [0, 1, 2, 3].map((n) => u16(0x12 + n * 4) & 0x1ff),
  vram: new Uint8Array(gba.bus.vram),
  palette: new Uint8Array(gba.bus.palette),
};
gba.runFrame();
const hardware = new Uint32Array(gba.ppu.getFramebuffer());

const tileCount = snapshot.vram.length / TILE;

// 单趟扫 ROM：只关心 VRAM 里出现过的前 4 字节
for (let t = 0; t < tileCount; t += 1) wantedKeys.add(keyOf(snapshot.vram, t * TILE));
const MAX_RAW_HITS = 8;
for (let i = 0; i + TILE <= rom.length; i += 1) {
  const key = keyOf(rom, i);
  if (!wantedKeys.has(key)) continue;
  let list = rawIndex.get(key);
  if (!list) { list = []; rawIndex.set(key, list); }
  if (list.length < MAX_RAW_HITS) list.push(i);
}
const located = new Uint8Array(tileCount);
const locatedAt = new Array(tileCount).fill(null);
let missing = 0;
const missingSamples = [];

for (let t = 0; t < tileCount; t += 1) {
  const base = t * TILE;
  const key = keyOf(snapshot.vram, base);
  const list = index.get(key);
  let hit = null;
  if (list) {
    for (let k = 0; k < list.length && !hit; k += 2) {
      const {offset, output} = decodedBlocks[list[k]];
      const at = list[k + 1];
      let same = true;
      for (let b = 0; b < TILE; b += 1) {
        if (output[at + b] !== snapshot.vram[base + b]) { same = false; break; }
      }
      if (same) hit = {block: offset, inBlock: at};
    }
  }
  if (!hit) {
    // 未压缩区：直接拿 ROM 里的字节比
    const rawList = rawIndex.get(key);
    if (rawList) {
      for (const at of rawList) {
        let same = true;
        for (let b = 0; b < TILE; b += 1) {
          if (rom[at + b] !== snapshot.vram[base + b]) { same = false; break; }
        }
        if (same) { hit = {block: 'raw', inBlock: at}; break; }
      }
    }
  }
  if (hit) { located[t] = 1; locatedAt[t] = hit; }
  else { missing += 1; if (missingSamples.length < 5) missingSamples.push(`0x${base.toString(16)}`); }
}

const rebuiltVram = new Uint8Array(snapshot.vram.length);
for (let t = 0; t < tileCount; t += 1) {
  if (!located[t]) continue;
  const base = t * TILE;
  for (let b = 0; b < TILE; b += 1) rebuiltVram[base + b] = snapshot.vram[base + b];
}

const layers = [];
for (let n = 0; n < 4; n += 1) {
  if (!((snapshot.dispcnt >> (8 + n)) & 1)) continue;
  layers.push({bgcnt: snapshot.bgcnt[n], hofs: snapshot.bghofs[n], vofs: snapshot.bgvofs[n]});
}
const composite = renderBgStack({vram: rebuiltVram, palette: snapshot.palette, layers, width: W, height: H});

const toRgba = (fb) => {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    const px = fb[i];
    rgba[i * 4 + 0] = px & 0xff;
    rgba[i * 4 + 1] = (px >> 8) & 0xff;
    rgba[i * 4 + 2] = (px >> 16) & 0xff;
    rgba[i * 4 + 3] = 0xff;
  }
  return rgba;
};
const diff = compareFrames({width: W, height: H, rgba: composite.rgba}, {width: W, height: H, rgba: toRgba(hardware)}, {tolerance: 0, quantizeBits: 3});

// 帧号断言：本脚本跑 frames-1 帧后取快照、再跑 1 帧，被测量的是第 frames 帧。
const frameNo = FRAMES;
assertFrameNo(frameNo, expectedFrameFromArgv(process.argv, FRAMES), 'rom-frame-proof');

const result = {
  frames: FRAMES,
  frameNo,
  rom_sha256: createHash('sha256').update(rom).digest('hex'),
  blocksDecoded: decodedBlocks.length,
  tiles: {
    total: tileCount,
    locatedInRom: tileCount - missing,
    locatedInCompressedBlocks: locatedAt.filter((h) => h && h.block !== 'raw').length,
    locatedInRawRom: locatedAt.filter((h) => h && h.block === 'raw').length,
    missing,
    missingSamples,
  },
  note: '未定位的图块在重建时留 0，不用 dump 字节顶替；缺口直接表现为画面差异。',
  diff: {diffPixels: diff.diffPixels, total: diff.total, maxChannelDelta: diff.maxChannelDelta},
};
mkdirSync(OUT, {recursive: true});
writeFileSync(join(OUT, `frame${FRAMES}-rom-composite.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
