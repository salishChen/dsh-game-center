/**
 * 游戏在一帧里到底把 BLDCNT 改成什么样？
 *
 * 用途：解释"取法 A（跑帧前写一次）得到 1,250、取法 C（逐扫描线强制写 0x0c42）得到 931"
 * 的差从哪来。如果 A 的写入一直生效到帧末，那 A 与 C 都是"整帧关混合"，
 * 两者就不该有差 —— 有差说明**游戏自己在帧内改写了 BLDCNT**，A 的强制值只覆盖了一部分行。
 */
import {readFileSync} from 'node:fs';

import {bootKernel} from '../src/app/boot.js';

const ROM = process.env.FE8_ROM ?? 'C:/Users/salis/Desktop/dsh-game-boy/artifacts/fe8-remake/fe8-zh.gba';
const FRAMES = Number(process.argv[2] ?? 900);

const rom = new Uint8Array(readFileSync(ROM));
const gba = bootKernel(rom);
for (let i = 0; i < FRAMES - 1; i += 1) gba.runFrame();
const state = structuredClone(gba.serialize());

const perLine = new Array(160).fill(null);
const original = gba.ppu.renderScanline.bind(gba.ppu);
gba.ppu.renderScanline = (line, bus) => {
  perLine[line] = bus.mmioRegisters[0x50] | (bus.mmioRegisters[0x51] << 8);
  return original(line, bus);
};

gba.deserialize(state);
gba.runFrame();
gba.deserialize(state);

// 把连续相同的行压成区间
const ranges = [];
for (let line = 0; line < 160; line += 1) {
  const value = perLine[line];
  const last = ranges[ranges.length - 1];
  if (last && last.value === value) last.to = line;
  else ranges.push({from: line, to: line, value});
}

console.log(JSON.stringify({
  frames: FRAMES,
  distinctValues: [...new Set(perLine)].map((v) => (v === null ? null : `0x${v.toString(16).padStart(4, '0')}`)),
  changeCount: ranges.length - 1,
  ranges: ranges.map((r) => ({from: r.from, to: r.to, value: `0x${Number(r.value).toString(16).padStart(4, '0')}`})),
}, null, 2));
