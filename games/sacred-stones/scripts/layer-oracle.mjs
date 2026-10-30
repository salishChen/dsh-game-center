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
// 两轮：
//   第一轮（--round 1，默认）BLDCNT 清零，比"原始像素"——验证合成器本身；
//   第二轮（--round 2）BLDCNT 保持原值，比"混合后像素"——验证颜色特效。
//   特效必须在 5 位域算（硬件就是那么算的），所以第二轮照样量化后比，不给容差。
//
// 用法：
//   node scripts/layer-oracle.mjs [--rom <path>] [--frames 900] [--bg 0|auto] [--round 1|2] [--out <dir>]
//
// 退出码（写进约定，批量脚本必须按它分派）：
//   0 = 至少一层逐像素相符
//   1 = 有层不符（真问题）
//   2 = 用法/输入错误（找不到卡带等）
//   3 = 无判据（层是空的，或第二轮特效没触发过）——**不是通过**，别当 0 处理

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Gba, BOOT_STACK_POINTERS} from '@gba-kit/gba-emulator';
import {MODE_SYS} from '@gba-kit/arm-emulator/arm-cpu';
import {
  renderTextBg,
  flattenOnBackdrop,
  renderBgStackBlended,
  parseBgcnt,
} from '../src/extract/bg-render.js';
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
const round = Number(argOf('round', '1'));
// --target self：把这一层加成 BLDCNT 的第一目标，让特效**真的作用**在它身上。
// 不加这个开关时，很多帧的 BLDCNT 只指向 BG1，于是"第二轮相符"其实只证明了
// "特效没触发时我没乱改像素"——那是空判据，必须自己把通路点亮。
const targetMode = argOf('target', 'original');
// --effect 覆盖 BLDCNT 的 bit6..7：alpha / brighten / darken。
// 不覆盖时用帧里原值——但原值常常是"只对 BG1 生效"，等于没测到。
const effectArg = argOf('effect', 'original');
// 混合口径：'8bit' 与 @gba-kit 的实现逐位一致（它把 5 位展开成 8 位再算）；
// '5bit' 是真机（GBATEK）口径。要比对模拟器就必须选 8bit。
const blendDomain = argOf('blend-domain', '8bit');
if (blendDomain !== '5bit' && blendDomain !== '8bit') {
  console.error('--blend-domain 只支持 5bit（真机口径）或 8bit（@gba-kit 口径）');
  process.exit(2);
}
const EFFECT_MODE = {alpha: 1, brighten: 2, darken: 3};
if (effectArg !== 'original' && !(effectArg in EFFECT_MODE)) {
  console.error('--effect 只支持 original / alpha / brighten / darken');
  process.exit(2);
}
if (targetMode !== 'original' && targetMode !== 'self') {
  console.error('--target 只支持 original（照原样）或 self（把本层设成第一目标）');
  process.exit(2);
}
if (round !== 1 && round !== 2) {
  console.error('--round 只支持 1（清理特效，比原始像素）或 2（保留特效，比混合后像素）');
  process.exit(2);
}

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
  // 第一轮必须清零 BLDCNT：混合会让 framebuffer 与"原始像素"必然不同。
  // 第二轮保留原值：那一轮要验的正是混合，清了就等于把要测的东西删掉。
  // 把本层设成第一目标（bit0..3）时，同时要把 **BD 设成第二目标（bit13）**：
  // 只有第一目标而没有第二目标时，硬件不做混合（不是"和黑色混"）。
  // 注意第二目标在 bit8..13，不是 bit0..5 —— 写成 bit5 会让硬件完全不混合。
  let isolateBldcnt = round === 2
    ? (targetMode === 'self' ? (bldcnt | (1 << index) | (1 << 13)) : bldcnt)
    : 0;
  if (round === 2 && effectArg !== 'original') {
    isolateBldcnt = (isolateBldcnt & ~(0x3 << 6)) | (EFFECT_MODE[effectArg] << 6);
  }
  write16(0x50, isolateBldcnt);
  for (let y = 0; y < 160; y += 1) gba.ppu.renderScanline(y, gba.bus);
  const fb = gba.ppu.getFramebuffer();
  const bytes = Buffer.from(fb.buffer, fb.byteOffset, fb.byteLength);
  return {
    isolateDispcnt,
    isolateBldcnt,
    image: {width: 240, height: 160, rgba: Uint8Array.from(bytes)},
  };
}

const enabledLayers = [0, 1, 2, 3].filter((n) => (dispcnt >> (8 + n)) & 1);
const candidates = bgIndex >= 0 ? [bgIndex] : enabledLayers;
// 8 这个阈值的含义：「能区分出结构性画面与纯色/双色帧」。
// 一个真正有内容的图层（哪怕是两色 logo）在隔离渲染后至少有 8 种颜色；
// 只剩 1~2 种的帧必然是空的（关层、或在 VBlank 里被清过）。
// 不要把它调小来"凑出判据"——退化的相等（两张全黑 diff=0）和真的相等在数值上一样。
const MIN_COLORS = 8;

const results = [];
mkdirSync(outDir, {recursive: true});
for (const index of candidates) {
  const bgcnt = read16(0x08 + index * 2);
  const hofs = read16(0x10 + index * 4) & 0x1ff;
  const vofs = read16(0x12 + index * 4) & 0x1ff;
  const {isolateDispcnt, isolateBldcnt, image: oracle} = renderIsolatedLayer(index);
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

  const mine = round === 2
    ? renderBgStackBlended({
        vram,
        palette,
        layers: [{bgIndex: index, bgcnt, hofs, vofs}],
        bldcnt: isolateBldcnt,
        bldalpha: read16(0x52),
        bldy: read16(0x54) & 0x1f,
        blendDomain,
      })
    : flattenOnBackdrop(renderTextBg({vram, palette, bgcnt, hofs, vofs}), palette);
  // 模拟器把 5 位色按 v<<3 展开，我按 (v<<3)|(v>>2) 展开，同一颜色最多差 7。
  // 与其把容差放大（会连真实错误一起掩盖），不如两边都回到 5 位域比。
  // ── 触发证据（witness）─────────────────────────────────────────────
  // 相符必须建立在"被测分支真的执行过"上：样本非空、取值非单一、分支被触发。
  // 前两条由颜色数保证，第三条只能自己算：把特效关掉再合成一次，看有多少像素变了。
  const witness = (() => {
    if (round !== 2) return {effectApplied: null, blendedPixels: null};
    const withoutEffect = flattenOnBackdrop(
      renderTextBg({vram, palette, bgcnt, hofs, vofs}),
      palette,
    );
    let blendedPixels = 0;
    for (let i = 0; i < mine.rgba.length; i += 4) {
      if (
        mine.rgba[i] !== withoutEffect.rgba[i]
        || mine.rgba[i + 1] !== withoutEffect.rgba[i + 1]
        || mine.rgba[i + 2] !== withoutEffect.rgba[i + 2]
      ) blendedPixels += 1;
    }
    return {
      effectApplied: blendedPixels > 0,
      blendedPixels,
      firstTargetIncludesLayer: Boolean((isolateBldcnt >> index) & 1),
      secondTarget: (isolateBldcnt >> 13) & 1 ? 'backdrop' : 'none',
      mode: (isolateBldcnt >> 6) & 0x3,
      blendDomain,
    };
  })();

  if (round === 2 && witness.blendedPixels === 0) {
    results.push({
      bg: index,
      status: 'skip-nofire',
      reason:
        '这一轮特效没有真正作用在任何像素上（关掉特效后合成结果相同），'
        + '「相符」只证明了没触发时我没乱改像素；请加 --target self 或换 --effect',
      witness,
      registers: {bgcnt: hex(bgcnt), hofs, vofs, bldcntIsolated: hex(isolateBldcnt)},
    });
    continue;
  }

  const diff = compareFrames(mine, oracle, {tolerance: 0, quantizeBits: 3});
  const mineColors = distinctColors(mine.rgba);

  writeFileSync(join(outDir, `bg${index}-round${round}-oracle.png`), encodePng(oracle));
  writeFileSync(join(outDir, `bg${index}-round${round}-mine.png`), encodePng(mine));

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
      bldcntIsolated: hex(isolateBldcnt),
      bldcntTargeted: Boolean((isolateBldcnt >> index) & 1),
      bldalpha: hex(read16(0x52)),
      bldy: read16(0x54) & 0x1f,
    },
    colors: {oracle: oracleColors, mine: mineColors},
    witness,
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
  round,
  result: results.some((r) => r.status === 'mismatch')
    ? 'mismatch'
    : results.some((r) => r.status === 'match')
      ? 'match'
      : results.some((r) => r.status === 'skip-nofire')
        ? 'skip-nofire'
        : 'skip-blank',
  round2Targeting: round === 2 ? targetMode : undefined,
  round2Effect: round === 2 ? effectArg : undefined,
  blendDomain: round === 2 ? blendDomain : undefined,
  thresholds: {minColors: MIN_COLORS, whyMinColors: '能区分结构性画面与纯色/双色帧；调小会凑出退化的相等'},
  exitCodes: {0: '至少一层相符', 1: '有层不符', 2: '输入错误', 3: '无判据（不是通过）'},
  note:
    round === 2
      ? '第二轮的参照帧已把 DISPCNT 收成单层、BLDCNT 保留原值后重渲染；合成与混合都在 5 位域完成。空层不算判据。'
      : '参照帧已把 DISPCNT 收成单层、BLDCNT 置 0 后重渲染；合成只用同一帧的内存快照。空层不算判据。',
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
