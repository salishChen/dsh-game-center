/**
 * 只回答一个问题：**修前（跑帧前写一次 BLDCNT）与修后（逐扫描线强制写）算出的盲区，
 * 是同一个像素集合吗？** 只比计数会掩盖"换了一批像素"。
 *
 * 这里刻意不复用 mask-oracle：它已经是"修后"的取样法，混进去容易把两种取样搅在一起。
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

import {bootKernel} from '../src/app/boot.js';
import {renderTextBg, parseBgcnt} from '../src/extract/bg-render.js';
import {packMaskSha256} from '../src/extract/mask-pack.js';
import {decodePng, encodePng} from '../src/extract/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '.botharness-mask');
const ROM = process.env.FE8_ROM ?? 'C:/Users/salis/Desktop/dsh-game-boy/artifacts/fe8-remake/fe8-zh.gba';
const FRAMES = Number(process.argv[2] ?? 900);
const W = 240;
const H = 160;

const rom = new Uint8Array(readFileSync(ROM));
const gba = bootKernel(rom);
for (let i = 0; i < FRAMES - 1; i += 1) gba.runFrame();
const mmio = gba.bus.mmioRegisters;
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);
const snap = {
  bgcnt: [0, 1, 2, 3].map((n) => u16(0x08 + n * 2)),
  bghofs: [0, 1, 2, 3].map((n) => u16(0x10 + n * 4) & 0x1ff),
  bgvofs: [0, 1, 2, 3].map((n) => u16(0x12 + n * 4) & 0x1ff),
  vram: new Uint8Array(gba.bus.vram),
  palette: new Uint8Array(gba.bus.palette),
};
gba.runFrame();
const state = structuredClone(gba.serialize());

// 半帧对照（修前的真实形态）：**只在第 0 行渲染前写一次**，之后不再强制。
// 游戏随后会在同一帧内把值改回去，于是只有前半截生效 —— 这正是"看起来有对照、其实只有半帧"。
let sampled = null;
let oncePatch = null;
const original = gba.ppu.renderScanline.bind(gba.ppu);
gba.ppu.renderScanline = (line, bus) => {
  if (line === 0 && oncePatch !== null) {
    bus.mmioRegisters[0x50] = oncePatch & 0xff;
    bus.mmioRegisters[0x51] = (oncePatch >> 8) & 0xff;
  }
  if (line === 0) sampled = bus.mmioRegisters[0x50] | (bus.mmioRegisters[0x51] << 8);
  return original(line, bus);
};

function legacyFrame(patch) {
  gba.deserialize(state);
  oncePatch = patch;
  sampled = null;
  gba.runFrame();
  oncePatch = null;
  return {fb: new Uint32Array(gba.ppu.getFramebuffer()), sampled};
}

const withBlend = legacyFrame(null);        // 游戏自己的 0x0c42
const noBlend = legacyFrame(0x0000);        // 第 0 行写一次 0，随后被游戏改回

const bg1 = renderTextBg({
  vram: snap.vram, palette: snap.palette, bgcnt: snap.bgcnt[1],
  hofs: snap.bghofs[1], vofs: snap.bgvofs[1], width: W, height: H,
});
const cfg = parseBgcnt(snap.bgcnt[1]);
void cfg;

const mask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i += 1) mask[i] = bg1.rgba[i * 4 + 3] ? 1 : 0;

const blind = new Uint8Array(W * H);
for (let i = 0; i < W * H; i += 1) {
  if (withBlend.fb[i] === noBlend.fb[i] && mask[i]) blind[i] = 1;
}

const toGray = (m) => {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    const v = m[i] ? 255 : 0;
    rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return encodePng({width: W, height: H, rgba});
};

mkdirSync(OUT, {recursive: true});
const blindPng = toGray(blind);
writeFileSync(join(OUT, 'frame900-blindzone-legacy.png'), blindPng);

// 与修后的产物逐像素比（修后的盲区图由 mask-oracle.mjs 生成）
const fixedPath = join(OUT, 'frame900-blindzone.png');
let comparison = null;
try {
  const fixed = decodePng(readFileSync(fixedPath));
  let onlyLegacy = 0;
  let onlyFixed = 0;
  for (let i = 0; i < W * H; i += 1) {
    const legacyBit = blind[i] ? 1 : 0;
    const fixedBit = fixed.rgba[i * 4] ? 1 : 0;
    if (legacyBit && !fixedBit) onlyLegacy += 1;
    if (!legacyBit && fixedBit) onlyFixed += 1;
  }
  comparison = {
    legacyPixels: blind.reduce((n, v) => n + v, 0),
    fixedPixels: fixed.rgba.reduce((n, v, i) => n + (i % 4 === 0 && v ? 1 : 0), 0),
    onlyLegacy,
    onlyFixed,
    sameSet: onlyLegacy === 0 && onlyFixed === 0,
    legacySetSha: packMaskSha256(blind, {width: W, height: H}),
  };
} catch (error) {
  comparison = {error: `读不到修后产物：${error.message}`};
}

console.log(JSON.stringify({
  frames: FRAMES,
  legacySampledBldcnt: {withBlend: withBlend.sampled, noBlend: noBlend.sampled},
  legacyBlindPngSha256: createHash('sha256').update(blindPng).digest('hex'),
  comparison,
}, null, 2));
