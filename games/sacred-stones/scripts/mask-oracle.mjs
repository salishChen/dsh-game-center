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
import {packMaskSha256, maskConventionOf} from '../src/extract/mask-pack.js';

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

// 帧末回读是没用的：游戏在 VBlank 里把 BLDCNT 写回 0x0c42，所以 runFrame() 结束后
// 读到的一定是游戏的值，两次实验都会读到同一个数 —— 那正是"看起来有对照、其实没有"。
// 正确的取样点是**渲染期间**：包一层 renderScanline，在第 0 行被渲染的那一刻读寄存器。
// 只在渲染前写一次是不够的：实测游戏会在同一帧内把 BLDCNT 写回 0x0c42，
// 于是"改了 0 的那一次"只对前面若干行生效 —— 结果是一个**半帧对照**，
// 算出来的数自洽但不是我们要的实验。所以改成**每一条扫描线渲染前都强制写入**，
// 让整帧都处在被指定的配置下；witness 记的是我们写入后、渲染器读到的那个值。
let forceBldcnt = null;
let sampledBldcnt = null;
const originalRenderScanline = gba.ppu.renderScanline.bind(gba.ppu);
gba.ppu.renderScanline = (line, bus) => {
  if (forceBldcnt !== null) {
    bus.mmioRegisters[0x50] = forceBldcnt & 0xff;
    bus.mmioRegisters[0x51] = (forceBldcnt >> 8) & 0xff;
  }
  if (line === 0) {
    sampledBldcnt = bus.mmioRegisters[0x50] | (bus.mmioRegisters[0x51] << 8);
  }
  return originalRenderScanline(line, bus);
};

function hardwareFrame({bldcntPatch = null} = {}) {
  gba.deserialize(state);
  forceBldcnt = bldcntPatch;
  sampledBldcnt = null;
  gba.runFrame();
  forceBldcnt = null;
  const postFrame = gba.bus.mmioRegisters;
  return {
    fb: new Uint32Array(gba.ppu.getFramebuffer()),
    // 渲染期间实际生效的值（witness 的主证据）
    bldcntWhileRendering: sampledBldcnt,
    // 帧末的值（游戏写回的），一起记下来，正好说明"为什么不能用帧末值当证据"
    bldcntAfterFrame: postFrame[0x50] | (postFrame[0x51] << 8),
  };
}

const withBlend = hardwareFrame();
const noBlend = hardwareFrame({bldcntPatch: 0x0000});
gba.deserialize(state);

// 夹具自证：如果两次抓帧的 BLDCNT 回读相同，这个实验根本没有对照，直接拒绝出数。
if (withBlend.bldcntWhileRendering === noBlend.bldcntWhileRendering) {
  console.error(JSON.stringify({
    refused: 'bldcnt-toggle-ineffective',
    bldcntWhileRendering: `0x${Number(withBlend.bldcntWhileRendering).toString(16)}`,
    bldcntAfterFrame: {
      withBlend: `0x${Number(withBlend.bldcntAfterFrame).toString(16)}`,
      noBlend: `0x${Number(noBlend.bldcntAfterFrame).toString(16)}`,
    },
    hint: '两次配置抓帧时读回的 BLDCNT 相同：游戏在帧内把值改回去了，或补丁没写进去。盲区必须重算。',
  }, null, 2));
  process.exit(3);
}

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
  if (withBlend.fb[i] === noBlend.fb[i]) { blind[i] = 255; blindPixels += 1; }
  else blendVisibleWhereBg1 += 1;
}

// 按行打包的 1 bit 掩码摘要 = **像素集合相等**的判据。
// 比 PNG 文件 sha 强（不混编码器差异），也比计数强（计数相同仍可能位置不同）。
// 打包一律走 src/extract/mask-pack.js —— 那里有已知答案向量（用 Python 独立算出期望值），
// 不再在脚本里各写一份。上一版就是各写一份、还写成 LSB-first，导致同一个集合四个 sha。
const setSha = (pixels) => ({
  sha256: packMaskSha256(pixels, {width: W, height: H}),
  bytes: Math.ceil(W / 8) * H,
});

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
    // 盲区是 (frame, BLDCNT) 这一对的属性，不是这个游戏的属性：换帧或换 BLDCNT 必须重算。
    frame: FRAMES,
    bldcnt: `0x${snap.bldcnt.toString(16)}`,
    // 渲染期间实际生效的 BLDCNT（证据）；帧末值只作为"为什么不能用它当证据"的反面记录
    bldcntWhileRendering: {
      withBlend: `0x${Number(withBlend.bldcntWhileRendering).toString(16)}`,
      noBlend: `0x${Number(noBlend.bldcntWhileRendering).toString(16)}`,
    },
    bldcntAfterFrame: {
      withBlend: `0x${Number(withBlend.bldcntAfterFrame).toString(16)}`,
      noBlend: `0x${Number(noBlend.bldcntAfterFrame).toString(16)}`,
    },
    sampling: 'renderScanline(line=0) 挂钩取样；帧末回读不可用作证据（游戏会在 VBlank 写回）',
    set_sha256: setSha(blind).sha256,
    set_bytes: setSha(blind).bytes,
    mask_convention: maskConventionOf('bg1-opaque-and-same-result', {width: W, height: H, row_major: true, msb_first: true, pad: 'zero-to-byte'}),
    pixels: blindPixels,
    blendVisibleWhereBg1,
    assumption: '盲区 = 硬件在 BLDCNT=0x0c42 与 BLDCNT=0 两种配置下输出相同的像素 ∩ BG1 不透明；只改 BLDCNT，同一 savestate、同一帧、无容差',
    computedBy: 'reference-side (硬件自身两种配置对撞，被测实现不参与)',
    png_sha256: sha(blindPng),
    png_bytes: blindPng.length,
    hist16: hist16(blind),
  },
  mask: {
    set_sha256: setSha(mask).sha256,
    set_bytes: setSha(mask).bytes,
    mask_convention: maskConventionOf('bg1-opaque', {width: W, height: H, row_major: true, msb_first: true, pad: 'zero-to-byte'}),
    png_sha256: sha(maskPng),
    png_bytes: maskPng.length,
    hist16: hist16(mask),
  },
}, null, 2));
