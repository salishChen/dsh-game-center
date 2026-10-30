#!/usr/bin/env node
// 图层 oracle：让模拟器只画一层，再让我自己拼同一层，逐像素比。
//
// 为什么这样做：framebuffer 是 4 个 BG + OBJ + 窗口 + 颜色特效压平后的结果，
// 直接拿"我拼的 BG0"去比整屏，被精灵和其它层占住的像素全算差异，于是会拿着
// 一堆"我明明画对了"的红块去查合成器。所以参照帧要先变干净：
//   把 DISPCNT 改成"只开这一层"、BLDCNT 置 0，重渲染一次，再抓 framebuffer。
// 这样每一层都能单独验，差异出现在哪层就说明哪层错——分层是白送的。
//
// 还要注意两件在第一次跑就会踩的事：
//   1) 帧末读到 DISPCNT 不可信（游戏在 VBlank 里改寄存器），所以这里在
//      "取快照"时一次性把内存与寄存器都拷出来，之后合成只用这份拷贝；
//   2) BLDCNT/BLDALPHA/BLDY 一旦启用，framebuffer 里是混合后的像素，而拼出来的
//      是原始像素，混合区必红——所以抓参照帧前先把它们清零。
//
// 用法：
//   node scripts/layer-oracle.mjs [--rom <path>] [--frames 900] [--bg 0] [--out <dir>]

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Gba, BOOT_STACK_POINTERS} from '@gba-kit/gba-emulator';
import {MODE_SYS} from '@gba-kit/arm-emulator/arm-cpu';
import {renderTextBg, flattenOnBackdrop, parseBgcnt} from '../src/extract/bg-render.js';
import {compareFrames} from './compare-frame.mjs';
import {encodePng} from '../src/extract/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
const outDir = resolve(argOf('out', join(repoRoot, '.botharness', 'layer-oracle')));
const frames = Number(argOf('frames', '900'));
const bgIndex = argOf("bg", "auto") === "auto" ? -1 : Number(argOf("bg", "auto"));

if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

const rom = new Uint8Array(readFileSync(romPath));
const gba = new Gba();
gba.reset();
gba.loadRom(rom);
const cpu = gba.armCpu;
for (const [mode, sp] of BOOT_STACK_POINTERS) {
  cpu.switchMode(mode);
  cpu.registers[13] = sp;
}
cpu.switchMode(MODE_SYS);
cpu.cpsr = MODE_SYS;
cpu.registers[15] = 0x08000000;
for (let i = 0; i < frames; i += 1) gba.runFrame();

// mmioRegisters 是**字节**数组，read16 按小端取两个字节。用 byte offset 读，
// 不要用"寄存器序号"——那一版把 DISPCNT 读成了某个中间值，结论全偏。
const mmio = gba.bus.mmioRegisters;
const read16 = (offset) => mmio[offset] | (mmio[offset + 1] << 8);
const hex = (value) => `0x${value.toString(16).padStart(4, '0')}`;
const write16 = (offset, value) => {
  mmio[offset] = value & 0xff;
  mmio[offset + 1] = (value >> 8) & 0xff;
};

const dispcnt = read16(0x00);
const bldcnt = read16(0x50);
const vram = Uint8Array.from(gba.bus.vram);
const palette = Uint8Array.from(gba.bus.palette);

const distinctColors = (rgba) => {
  const set = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    set.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    if (set.size > 400) break;
  }
  return set.size;
};

// 把参照帧收成"只含这一层"再渲染。注意：这一层的开关本来就可能是关的
// （帧 900 时 DISPCNT=0x1e40，BG0 根本没开），所以不能假设 bgIndex 有内容——
// 必须先渲染一次、数一下颜色，空的参照帧等于没有判据。
function renderIsolatedLayer(index) {
  const isolateDispcnt = (dispcnt & 0x7) | (1 << (8 + index));
  write16(0x00, isolateDispcnt);
  write16(0x50, 0); // BLDCNT：混合会让 framebuffer 与"原始像素"必然不同
  for (let y = 0; y < 160; y += 1) gba.ppu.renderScanline(y, gba.bus);
  const fb = gba.ppu.getFramebuffer();
  const bytes = Buffer.from(fb.buffer, fb.byteOffset, fb.byteLength);
  return {
    isolateDispcnt,
    image: {width: 240, height: 160, rgba: Uint8Array.from(bytes)},
  };
}

const enabledLayers = [0, 1, 2, 3].filter((n) => (dispcnt >> (8 + n)) & 1);
const candidates = bgIndex >= 0 ? [bgIndex] : enabledLayers;
const MIN_COLORS = 8; // 少于这么多种颜色，说明这一层是空的，不能拿它当判据

const results = [];
mkdirSync(outDir, {recursive: true});
for (const index of candidates) {
  const bgcnt = read16(0x08 + index * 2);
  const hofs = read16(0x10 + index * 4) & 0x1ff;
  const vofs = read16(0x12 + index * 4) & 0x1ff;
  const {isolateDispcnt, image: oracle} = renderIsolatedLayer(index);
  const oracleColors = distinctColors(oracle.rgba);

  if (oracleColors < MIN_COLORS) {
    results.push({
      bg: index,
      status: 'skip-blank',
      reason: `隔离后只有 ${oracleColors} 种颜色，这一层是空的；空的参照帧不能当判据`,
      registers: {bgcnt: hex(bgcnt), hofs, vofs},
    });
    continue;
  }

  const layer = renderTextBg({vram, palette, bgcnt, hofs, vofs});
  const mine = flattenOnBackdrop(layer, palette);
  // 模拟器把 5 位色按 v<<3 展开，我按 (v<<3)|(v>>2) 展开，同一颜色最多差 7。
  // 与其把容差放大（会连真实错误一起掩盖），不如两边都回到 5 位域比。
  const diff = compareFrames(mine, oracle, {tolerance: 0, quantizeBits: 3});
  const mineColors = distinctColors(mine.rgba);

  writeFileSync(join(outDir, `bg${index}-oracle.png`), encodePng(oracle));
  writeFileSync(join(outDir, `bg${index}-mine.png`), encodePng(mine));

  results.push({
    bg: index,
    status: diff.diffPixels === 0 ? 'match' : 'mismatch',
    registers: {
      dispcntOriginal: hex(dispcnt),
      dispcntIsolated: hex(isolateDispcnt),
      bgcnt: hex(bgcnt),
      bgcntFields: parseBgcnt(bgcnt),
      hofs,
      vofs,
      bldcntOriginal: hex(bldcnt),
    },
    colors: {oracle: oracleColors, mine: mineColors},
    diff: {
      diffPixels: diff.diffPixels,
      total: diff.total,
      ratio: diff.ratio,
      quantizeBits: 3,
      maxChannelDelta: diff.maxChannelDelta,
      firstDiff: diff.firstDiff,
    },
  });
}

const summary = {
  frames,
  note: '参照帧已把 DISPCNT 收成单层、BLDCNT 置 0 后重渲染；合成只用同一帧的内存快照。空层不算判据。',
  registers: {dispcnt: hex(dispcnt), bldcnt: hex(bldcnt), enabledLayers},
  memory: {
    vramSha256: createHash('sha256').update(vram).digest('hex'),
    paletteSha256: createHash('sha256').update(palette).digest('hex'),
  },
  results,
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

const verified = results.filter((r) => r.status === 'match');
const mismatched = results.filter((r) => r.status === 'mismatch');
process.exit(mismatched.length === 0 && verified.length > 0 ? 0 : mismatched.length ? 1 : 3);
