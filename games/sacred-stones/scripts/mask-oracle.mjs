/**
 * 帧 900 的 BG1 掩码 + 盲区，全部按"参照侧"口径算：
 *
 *   mask      = 我的合成器里 BG1 该像素不透明（索引 != 0）。它是"我的说法"，等逆向对撞。
 *   blindzone = **硬件**在"开混合 / 关混合"两种配置下输出**完全相同**的像素 ∩ BG1 不透明。
 *
 * 盲区这条刻意不用我的合成结果参与：盲区若由被测实现的输出定义，它错在哪盲区就塌到哪。
 * 判据来自硬件自身（同一帧、同一 savestate，只改 BLDCNT），所以它是参照侧的。
 *
 * 只输出计数与 sha256，不输出图（对撞交换的东西里没有图）。
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

import {bootKernel} from '../src/app/boot.js';
import {parseBgcnt, renderTextBg} from '../src/extract/bg-render.js';
import {encodePng} from '../src/extract/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const ROM = process.env.FE8_ROM ?? 'C:/Users/salis/Desktop/dsh-game-boy/artifacts/fe8-remake/fe8-zh.gba';
const OUT = join(root, '.botharness-mask');

const FRAMES = Number(process.argv[2] ?? 900);
const W = 240, H = 160;
const gba = bootKernel(new Uint8Array(readFileSync(ROM)));
for (let i = 0; i < FRAMES - 1; i += 1) gba.runFrame();

const mmio = gba.bus.mmioRegisters;
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);
const snap = {
  dispcnt: u16(0x00),
  bldcnt: u16(0x50),
  bgcnt: [0, 1, 2, 3].map((n) => u16(0x08 + n * 2)),
  bghofs: [0, 1, 2, 3].map((n) => u16(0x10 + n * 4) & 0x1ff),
  bgvofs: [0, 1, 2, 3].map((n) => u16(0x12 + n * 4) & 0x1ff),
  vram: new Uint8Array(gba.bus.vram),
  palette: new Uint8Array(gba.bus.palette),
};
const state = structuredClone(gba.serialize());

function hardwareFrame({bldcntPatch = null} = {}) {
  gba.deserialize(state);
  const m = gba.bus.mmioRegisters;
  if (bldcntPatch != null) {
    m[0x50] = bldcntPatch & 0xff;
    m[0x51] = (bldcntPatch >> 8) & 0xff;
  }
  gba.runFrame();
  return new Uint32Array(gba.ppu.getFramebuffer());
}

const withBlend = hardwareFrame();
const noBlend = hardwareFrame({bldcntPatch: 0});
gba.deserialize(state);

// 我的 BG1 掩码
const bg1 = renderTextBg({
  vram: snap.vram, palette: snap.palette, bgcnt: snap.bgcnt[1],
  hofs: snap.bghofs[1], vofs: snap.bgvofs[1], width: W, height: H,
});
const bg1Cfg = parseBgcnt(snap.bgcnt[1]);

const mask = new Uint8Array(W * H);
let bg1Opaque = 0;
for (let i = 0; i < W * H; i += 1) {
  if (bg1.rgba[i * 4 + 3] !== 0) { mask[i] = 255; bg1Opaque += 1; }
}

// 盲区：硬件开/关混合输出相同 ∩ BG1 不透明
const blind = new Uint8Array(W * H);
let blindPixels = 0;
let blendVisibleWhereBg1 = 0;
for (let i = 0; i < W * H; i += 1) {
  if (mask[i] === 0) continue;
  if (withBlend[i] === noBlend[i]) { blind[i] = 255; blindPixels += 1; }
  else blendVisibleWhereBg1 += 1;
}

const grayPng = (pixels) => {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    const v = pixels[i];
    rgba[i * 4 + 0] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 0xff;
  }
  return encodePng({width: W, height: H, rgba});
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const maskPng = grayPng(mask);
const blindPng = grayPng(blind);

mkdirSync(OUT, {recursive: true});
writeFileSync(join(OUT, `frame${FRAMES}-bg1-mask.png`), maskPng);
writeFileSync(join(OUT, `frame${FRAMES}-blindzone.png`), blindPng);

const hist16 = (pixels) => {
  const blocks = [];
  for (let by = 0; by < H / 16; by += 1) {
    for (let bx = 0; bx < W / 16; bx += 1) {
      let n = 0;
      for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) if (pixels[(by * 16 + y) * W + bx * 16 + x]) n += 1;
      if (n) blocks.push({bx, by, n});
    }
  }
  return blocks;
};

console.log(JSON.stringify({
  frames: FRAMES,
  source: {
    dispcnt: `0x${snap.dispcnt.toString(16)}`,
    bldcnt: `0x${snap.bldcnt.toString(16)}`,
    vram_sha256: sha(snap.vram),
    palette_sha256: sha(snap.palette),
    bg1: {bgcnt: `0x${snap.bgcnt[1].toString(16)}`, priority: bg1Cfg.priority, hofs: snap.bghofs[1], vofs: snap.bgvofs[1]},
  },
  bg1Opaque,
  blindzone: {
    pixels: blindPixels,
    blendVisibleWhereBg1,
    assumption: '盲区 = 硬件在 BLDCNT=0x0c42 与 BLDCNT=0 两种配置下输出相同的像素 ∩ BG1 不透明；只改 BLDCNT，同一 savestate、同一帧、无容差',
    computedBy: 'reference-side (硬件自身两种配置对撞，被测实现不参与)',
    png_sha256: sha(blindPng),
    png_bytes: blindPng.length,
    hist16: hist16(blind),
  },
  mask: {
    png_sha256: sha(maskPng),
    png_bytes: maskPng.length,
    hist16: hist16(mask),
  },
}, null, 2));
