#!/usr/bin/env node
// OBJ（精灵）单层 oracle：让模拟器只画精灵层，我自己拼同一层，逐像素比。
//
// 与 BG 那套（scripts/layer-oracle.mjs）同源，但规则完全不同：
//   * 图块编号怎么变成地址，取决于 DISPCNT **bit6**（1D/2D 映射），不是 BGxCNT；
//   * 16 色模式的 bank 来自 attr2 bit12，256 色模式没有 bank（用整块 256 色调色板）；
//   * 精灵调色板从 0x200 开始（前 0x200 是 BG 的）；
//   * 尺寸由 shape(attr0 bit14-15) 与 size(attr1 bit14-15) **两个字段共同**决定；
//   * priority 小的在上面，同 priority 时 OAM 序号小的在上。
//
// 用法：
//   node scripts/obj-oracle.mjs [--rom <path>] [--frames 900] [--out <dir>]
//
// 退出码与 layer-oracle 一致：0 相符 / 1 不符 / 2 输入错误 / 3 无判据。

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Gba, BOOT_STACK_POINTERS} from '@gba-kit/gba-emulator';
import {MODE_SYS} from '@gba-kit/arm-emulator/arm-cpu';
import {renderObjLayer, parseObj} from '../src/extract/obj-render.js';
import {backdropColor} from '../src/extract/bg-render.js';
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
const outDir = resolve(argOf('out', join(repoRoot, '.botharness', 'obj-oracle')));
const frames = Number(argOf('frames', '900'));

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

const mmio = gba.bus.mmioRegisters;
const read16 = (offset) => mmio[offset] | (mmio[offset + 1] << 8);
const write16 = (offset, value) => {
  mmio[offset] = value & 0xff;
  mmio[offset + 1] = (value >> 8) & 0xff;
};
const hex = (value) => `0x${value.toString(16).padStart(4, '0')}`;

const dispcnt = read16(0x00);
const bldcnt = read16(0x50);
const oam = Uint8Array.from(gba.bus.oam);
const vram = Uint8Array.from(gba.bus.vram);
const palette = Uint8Array.from(gba.bus.palette);

// 只开 OBJ、只留 mode 0，清掉特效：参照帧必须是"硬件渲染的纯精灵层"。
write16(0x00, (dispcnt & 0x7) | (1 << 12));
write16(0x50, 0);
for (let y = 0; y < 160; y += 1) gba.ppu.renderScanline(y, gba.bus);
const fb = gba.ppu.getFramebuffer();
const oracle = {width: 240, height: 160, rgba: Uint8Array.from(Buffer.from(fb.buffer, fb.byteOffset, fb.byteLength))};

const distinctColors = (rgba) => {
  const set = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    set.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    if (set.size > 400) break;
  }
  return set.size;
};

const oracleColors = distinctColors(oracle.rgba);
const visible = [];
for (let i = 0; i < 128; i += 1) {
  const obj = parseObj(
    oam[i * 8] | (oam[i * 8 + 1] << 8),
    oam[i * 8 + 2] | (oam[i * 8 + 3] << 8),
    oam[i * 8 + 4] | (oam[i * 8 + 5] << 8),
  );
  if (!obj.hide && obj.dimsValid) visible.push({index: i, ...obj});
}

const mine = renderObjLayer({
  oam,
  vram,
  palette,
  dispcnt,
  backdrop: backdropColor(palette),
});

mkdirSync(outDir, {recursive: true});
writeFileSync(join(outDir, 'obj-oracle.png'), encodePng(oracle));
writeFileSync(join(outDir, 'obj-mine.png'), encodePng(mine));

const MIN_COLORS = 8;
if (oracleColors < MIN_COLORS) {
  const summary = {
    frames,
    result: 'skip-blank',
    reason: `隔离后只有 ${oracleColors} 种颜色：这一帧的精灵层是空的，空的参照帧不算判据`,
    thresholds: {minColors: MIN_COLORS},
    registers: {dispcnt: hex(dispcnt), bldcnt: hex(bldcnt)},
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(3);
}

const diff = compareFrames(mine, oracle, {tolerance: 0, quantizeBits: 3});
const summary = {
  frames,
  result: diff.diffPixels === 0 ? 'match' : 'mismatch',
  oneDimensional: Boolean((dispcnt >> 6) & 1),
  visibleObjects: visible.length,
  objectSizes: visible.reduce((acc, o) => {
    const key = `${o.width}x${o.height}${o.colorMode8bpp ? '/256' : '/16'}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
  affineObjects: visible.filter((o) => o.affine).length,
  paletteSha256: createHash('sha256').update(palette).digest('hex'),
  vramSha256: createHash('sha256').update(vram).digest('hex'),
  registers: {dispcnt: hex(dispcnt), bldcnt: hex(bldcnt)},
  colors: {oracle: oracleColors, mine: distinctColors(mine.rgba)},
  witness: {paintedPixels: mine.paintedPixels, branchRan: mine.paintedPixels > 0},
  diff: {
    diffPixels: diff.diffPixels,
    total: diff.total,
    ratio: diff.ratio,
    quantizeBits: 3,
    maxChannelDelta: diff.maxChannelDelta,
    firstDiff: diff.firstDiff,
  },
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(diff.diffPixels === 0 ? 0 : 1);
