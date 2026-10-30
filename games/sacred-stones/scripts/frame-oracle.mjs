/**
 * 整屏 oracle：把「BG 叠层 + 颜色混合（+OBJ）」合成一张 240×160，和模拟器真实帧逐像素比。
 *
 * 与 layer-oracle 的区别：layer-oracle 每次只开一层（先证明单层对），
 * 这里不做隔离——直接拿游戏自己设置好的寄存器去合成整屏，验证的是「层间关系」：
 * priority 谁压谁、第一目标与第二目标怎么配、BD 出现与否。
 *
 * 判据来自 GBATEK：BLDCNT bit0..5 = 第一目标层、bit6..7 = 模式、bit8..13 = 第二目标层、
 * bit13 = BD（背景色也算第二目标）。第一目标与"它下面那一层"混合。
 *
 * 用法：node scripts/frame-oracle.mjs [--frames 900] [--out <dir>] [--with-obj]
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {bootKernel} from '../src/app/boot.js';
import {parseBgcnt, renderTextBg, backdropColor} from '../src/extract/bg-render.js';
import {renderObjLayer} from '../src/extract/obj-render.js';
import {parseBldcnt, blend5, rgbaTo5, write5To, BLEND_MODE} from '../src/extract/color.js';
import {shouldBlend} from '../src/extract/composite.js';
import {encodePng} from '../src/extract/png.js';
import {compareFrames} from './compare-frame.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const frames = Number(argOf('frames', '900'));
const withObj = args.includes('--with-obj');
const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
const outDir = resolve(argOf('out', join(repoRoot, '.botharness', 'frame-oracle')));

if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

const rom = new Uint8Array(readFileSync(romPath));
const gba = bootKernel(rom);
// 寄存器时序（这一条决定整屏 oracle 是否有意义）：
//   游戏在 **VBlank** 里改 DISPCNT/BLDCNT，所以"跑完 N 帧后读到的寄存器"是给 **第 N+1 帧** 用的。
//   要拿"和第 N 帧画面配套的寄存器"，必须在第 N-1 帧结束时读，然后跑第 N 帧取 framebuffer。
for (let i = 0; i < Math.max(0, frames - 1); i += 1) gba.runFrame();

const bus = gba.bus;
const mmio = bus.mmioRegisters;
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);

const dispcnt = u16(0x00);
const bldcntValue = u16(0x50);
const bldalpha = u16(0x52);
const bldy = u16(0x54) & 0xff;
const bgcnt = [0, 1, 2, 3].map((n) => u16(0x08 + n * 2));
const bghofs = [0, 1, 2, 3].map((n) => u16(0x10 + n * 4) & 0x1ff);
const bgvofs = [0, 1, 2, 3].map((n) => u16(0x12 + n * 4) & 0x1ff);

const vram = Uint8Array.from(bus.vram);
const palette = Uint8Array.from(bus.palette);
const oam = Uint8Array.from(bus.oam);

const fbSnapshot = () => gba.ppu.getFramebuffer();
gba.runFrame();
const fb = fbSnapshot();
const oracle = {width: 240, height: 160, rgba: new Uint8Array(Buffer.from(fb.buffer, fb.byteOffset, fb.byteLength))};

// 真实帧就是硬件画的，不能改寄存器重渲染；这里只用它当参照。

const W = 240;
const H = 160;
const bld = parseBldcnt(bldcntValue);
const eva = bldalpha & 0x1f;
const evb = (bldalpha >> 8) & 0x1f;
const mode = bld.mode === 1 ? BLEND_MODE.ALPHA : bld.mode === 2 ? BLEND_MODE.BRIGHTEN : bld.mode === 3 ? BLEND_MODE.DARKEN : BLEND_MODE.NONE;

const layers = [];
for (let n = 0; n < 4; n += 1) {
  if (!((dispcnt >> (8 + n)) & 1)) continue; // 层没开
  const cfg = parseBgcnt(bgcnt[n]);
  layers.push({
    index: n,
    cfg,
    priority: cfg.priority,
    image: renderTextBg({vram, palette, bgcnt: bgcnt[n], hofs: bghofs[n], vofs: bgvofs[n], width: W, height: H}),
    isFirst: bld.targetsBg.includes(n),
    isSecond: bld.secondTargetsBg.includes(n),
  });
}
// priority 小的在上；同 priority 层号小的在上（硬件行为）
layers.sort((a, b) => (a.priority - b.priority) || (a.index - b.index));

const backdrop = backdropColor(palette);
const objLayer = withObj ? renderObjLayer({oam, vram, palette, dispcnt, backdrop: null}) : null;

const out = new Uint8Array(W * H * 4);
// blendedPixels 的口径必须写死，否则三个人说的"混合像素数"是三个意思：
//   branch   (a) 执行了混合分支的像素数（当前 blendedPixels 就是这个）
//   changed  (b) 混合结果 != 第一目标原值 的像素数（同色重叠会被排除，故 (b) <= (a)）
//   exactHalf (c) 输出恰好 == (第一目标+第二目标)>>1 的像素数（逐通道，5 位域）
let blendedPixels = 0;
let blendChanged = 0;
let blendExactHalf = 0;
// 为了和逆向的 ab_test 三个字段对账：BG1 不透明像素数、其中"下方存在第二目标层"的像素数。
let bg1Opaque = 0;
let bg1WithSecondBelow = 0;
for (let i = 0; i < W * H; i += 1) {
  const at = i * 4;
  // 自下而上找最上面两层可见内容
  const stack = [];
  for (const layer of layers) {
    if (layer.image.rgba[at + 3] === 0) continue;
    stack.push({kind: 'bg', layer, rgba: layer.image.rgba, priority: layer.priority, isFirst: layer.isFirst, isSecond: layer.isSecond});
  }
  if (objLayer && objLayer.rgba[at + 3] !== 0) {
    stack.push({
      kind: 'obj',
      rgba: objLayer.rgba,
      // 每个精灵有自己的 priority；取整层的逐像素优先级表，不能一律当 0。
      priority: objLayer.priorityMap[i] === 0xff ? 0 : objLayer.priorityMap[i],
      isFirst: Boolean(bld.targetObj),
      isSecond: Boolean(bld.secondTargetObj),
      objMode: 'normal',
    });
  }
  stack.sort((a, b) => (a.priority - b.priority) || (a.kind === 'obj' ? -1 : 1));

  if (stack.length === 0) {
    out[at] = backdrop[0];
    out[at + 1] = backdrop[1];
    out[at + 2] = backdrop[2];
    out[at + 3] = 0xff;
    continue;
  }
  const top = stack[0];
  let rgba = [top.rgba[at], top.rgba[at + 1], top.rgba[at + 2]];
  const below = stack[1];
  const belowIsSecond = below ? below.isSecond : Boolean(bld.secondTargetBackdrop);
  const belowRgba = below ? [below.rgba[at], below.rgba[at + 1], below.rgba[at + 2]] : backdrop;

  const topIsBg1 = top.kind === 'bg' && top.layer && top.layer.index === 1;
  if (topIsBg1) {
    bg1Opaque += 1;
    if (below && below.isSecond) bg1WithSecondBelow += 1;
  }

  if (mode !== BLEND_MODE.NONE && shouldBlend({
    topIsFirst: Boolean(top.isFirst),
    belowExists: Boolean(below),
    belowIsSecond,
    backdropInSecond: Boolean(bld.secondTargetBackdrop),
  })) {
    // 真机在 5 位域做混合（GBATEK）：先降到 5 位、混完再展开，才是硬件口径。
    const top5 = rgbaTo5(rgba, 0);
    const below5 = rgbaTo5(belowRgba, 0);
    const out5 = new Uint8Array(4);
    const blended = blend5(top5, below5, {mode, eva, evb, evy: bldy});
    write5To(out5, 0, blended);
    rgba = [out5[0], out5[1], out5[2]];
    blendedPixels += 1;
    if (out5[0] !== top5[0] || out5[1] !== top5[1] || out5[2] !== top5[2]) blendChanged += 1;
    if (out5[0] === (top5[0] + below5[0]) >> 1
      && out5[1] === (top5[1] + below5[1]) >> 1
      && out5[2] === (top5[2] + below5[2]) >> 1) blendExactHalf += 1;
  }
  out[at] = rgba[0];
  out[at + 1] = rgba[1];
  out[at + 2] = rgba[2];
  out[at + 3] = 0xff;
}

const mine = {width: W, height: H, rgba: out};
const diff = compareFrames(mine, oracle, {tolerance: 0, quantizeBits: 3});

mkdirSync(outDir, {recursive: true});
writeFileSync(join(outDir, `frame${frames}-oracle.png`), encodePng(oracle));
writeFileSync(join(outDir, `frame${frames}-mine.png`), encodePng(mine));

const summary = {
  frames,
  withObj,
  registers: {
    dispcnt: `0x${dispcnt.toString(16)}`,
    bgcnt: bgcnt.map((v) => `0x${v.toString(16)}`),
    bghofs,
    bgvofs,
    bldcnt: `0x${bldcntValue.toString(16)}`,
    bldalpha: `0x${bldalpha.toString(16)}`,
    bldy,
  },
  bld: {
    firstTarget: layers.filter((l) => l.isFirst).map((l) => l.index),
    secondTarget: layers.filter((l) => l.isSecond).map((l) => l.index),
    secondTargetBackdrop: Boolean(bld.secondTargetBackdrop),
    mode: bld.mode,
    eva,
    evb,
    evy: bldy,
  },
  witness: {
    layersDrawn: layers.map((l) => l.index),
    blendedPixels,
    blendStats: {
      branch: blendedPixels,
      changed: blendChanged,
      exactHalf: blendExactHalf,
      bg1Opaque,
      bg1WithSecondBelow,
      definition: 'branch=(a) 执行混合分支; changed=(b) 结果≠第一目标原值; exactHalf=(c) 结果==(top+below)>>1（5 位域逐通道）',
    },
    objPainted: objLayer ? objLayer.paintedPixels : 0,
    colorCount: new Set(Array.from({length: W * H}, (_, i) => (out[i * 4] << 16) | (out[i * 4 + 1] << 8) | out[i * 4 + 2])).size,
  },
  diff,
  result: diff.diffPixels === 0 ? 'match' : 'mismatch',
};

writeFileSync(join(outDir, `frame${frames}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({result: summary.result, diffPixels: diff.diffPixels, ratio: diff.ratio, witness: summary.witness}, null, 2));
