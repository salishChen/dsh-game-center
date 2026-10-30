/**
 * BG 层「不透明掩码」oracle。
 *
 * 为什么需要它：混合只在**第一目标像素不透明**的地方发生，所以"某层在哪儿不透明"
 * 本身就是必须验证的量。层 oracle 只能证明"非透明像素画对了"，透明像素它看不见
 * （那一项被判 skip-blank 时更是连颜色都只有一种）。
 *
 * 手法：把调色板 0 号色临时改成洋红，隔离该层重渲染一帧。
 *   - 硬件显示洋红 ⇒ 该像素透明（露出背景色）
 *   - 硬件显示别的 ⇒ 该像素不透明
 * 于是拿到真掩码，和自己的掩码做差集。这一步不改任何 ROM 数据，只改运行时调色板。
 *
 * 用法：node scripts/layer-mask-oracle.mjs [--frames 900] [--bg 1] [--out <dir>]
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {bootKernel} from '../src/app/boot.js';
import {renderTextBg} from '../src/extract/bg-render.js';
import {encodePng} from '../src/extract/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const frames = Number(argOf('frames', '900'));
const bgIndex = Number(argOf('bg', '1'));
const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
const outDir = resolve(argOf('out', join(repoRoot, '.botharness', 'layer-mask-oracle')));

if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

// 洋红：BGR555 = r31, g0, b31 → 0x7C1F
const MAGENTA_5 = 0x7c1f;
const MAGENTA = [(31 << 3) | (31 >> 2), 0, (31 << 3) | (31 >> 2)];

const rom = new Uint8Array(readFileSync(romPath));
const gba = bootKernel(rom);
for (let i = 0; i < frames; i += 1) gba.runFrame();
gba.runFrame();

const bus = gba.bus;
const mmio = bus.mmioRegisters;
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);
const w16 = (at, v) => {
  mmio[at] = v & 0xff;
  mmio[at + 1] = (v >> 8) & 0xff;
};

const dispcnt = u16(0x00);
const bgcnt = u16(0x08 + bgIndex * 2);
const hofs = u16(0x10 + bgIndex * 4) & 0x1ff;
const vofs = u16(0x12 + bgIndex * 4) & 0x1ff;

// 快照（掩码实验要用"修改后"的调色板，所以先拷一份原始调色板再改）
const vram = Uint8Array.from(bus.vram);
const palette = Uint8Array.from(bus.palette);
palette[0] = MAGENTA_5 & 0xff;
palette[1] = MAGENTA_5 >> 8;

// 硬件侧：同一份调色板改到硬件里，只开这一层，清特效
bus.palette.set(palette);
w16(0x00, (dispcnt & 0x7) | (1 << (8 + bgIndex)));
w16(0x50, 0);
for (let y = 0; y < 160; y += 1) gba.ppu.renderScanline(y, bus);
const fb = gba.ppu.getFramebuffer();
const oracle = new Uint8Array(Buffer.from(fb.buffer, fb.byteOffset, fb.byteLength));

// 我这侧：用同一份调色板合成
const mine = renderTextBg({vram, palette, bgcnt, hofs, vofs, width: 240, height: 160});

const same = (a, b, tol = 2) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

let hwOpaque = 0;
let myOpaque = 0;
let onlyHw = 0;
let onlyMine = 0;
const diffMask = new Uint8Array(240 * 160 * 4);
for (let i = 0; i < 240 * 160; i += 1) {
  const at = i * 4;
  const hw = [oracle[at], oracle[at + 1], oracle[at + 2]];
  const isHwOpaque = !same(hw, MAGENTA);
  const isMineOpaque = mine.rgba[at + 3] !== 0;
  if (isHwOpaque) hwOpaque += 1;
  if (isMineOpaque) myOpaque += 1;
  let color = null;
  if (isHwOpaque && !isMineOpaque) { onlyHw += 1; color = [255, 0, 0]; }
  else if (!isHwOpaque && isMineOpaque) { onlyMine += 1; color = [0, 128, 255]; }
  if (color) {
    diffMask[at] = color[0];
    diffMask[at + 1] = color[1];
    diffMask[at + 2] = color[2];
    diffMask[at + 3] = 0xff;
  }
}

mkdirSync(outDir, {recursive: true});
writeFileSync(join(outDir, `bg${bgIndex}-hw.png`), encodePng({width: 240, height: 160, rgba: oracle}));
writeFileSync(join(outDir, `bg${bgIndex}-mine.png`), encodePng(mine));
writeFileSync(join(outDir, `bg${bgIndex}-maskdiff.png`), encodePng({width: 240, height: 160, rgba: diffMask}));

const summary = {
  frames,
  bg: bgIndex,
  registers: {dispcnt: `0x${dispcnt.toString(16)}`, bgcnt: `0x${bgcnt.toString(16)}`, hofs, vofs},
  mask: {hwOpaque, myOpaque, onlyHw, onlyMine, same: onlyHw === 0 && onlyMine === 0},
  legend: {red: '硬件不透明、我这里透明', blue: '我这里不透明、硬件透明'},
};
writeFileSync(join(outDir, `bg${bgIndex}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
