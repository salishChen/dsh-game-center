/**
 * 导出「同一帧」的寄存器 + VRAM + 调色板，给逆向做地图/图块合成。
 *
 * 为什么必须同帧：寄存器与 VRAM 差一帧，滚动量就对不上，合成出来整屏横移一格，
 * 看起来像"图块顺序错了"。所以这里一次性从同一个 `bus` 快照里读全部数据。
 *
 * 输出（PM 指定格式）：
 *   {frame, dispcnt, bgcnt[4], bghofs[4], bgvofs[4], bldcnt, bldalpha, bldy,
 *    vram_base64, vram_sha256, palette_base64, palette_sha256, self_sha256}
 *
 * 用法：node scripts/frame-export.mjs --frames 900 [--out extract/frame900.json]
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {bootKernel} from '../src/app/boot.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const frames = Number(argOf('frames', '900'));
const romPath = resolve(argOf('rom', join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba')));
const outPath = resolve(argOf('out', join(here, '..', 'extract', `frame${frames}.json`)));

if (!existsSync(romPath)) {
  console.error(`找不到卡带：${romPath}`);
  process.exit(2);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hex = (n, width = 4) => `0x${(n >>> 0).toString(16).padStart(width, '0')}`;

const rom = new Uint8Array(readFileSync(romPath));
const gba = bootKernel(rom);
for (let i = 0; i < frames; i += 1) gba.runFrame();

const bus = gba.bus;
const mmio = bus.mmioRegisters;
// mmioRegisters 是 Uint8Array（1024 字节，按字节寻址）：
// DISPCNT 在 byte 0..1（小端）、BGxCNT 在 0x08 + n*2、BGxHOFS 在 0x10 + n*4、BGxVOFS 在 0x12 + n*4、
// BLDCNT 在 0x50、BLDALPHA 0x52、BLDY 0x54。按"寄存器序号"读会读成另一件事（踩过）。
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);

const vram = new Uint8Array(bus.vram);
const palette = new Uint8Array(bus.palette);

const payload = {
  frame: frames,
  dispcnt: hex(u16(0x00)),
  bgcnt: [0, 1, 2, 3].map((n) => hex(u16(0x08 + n * 2))),
  bghofs: [0, 1, 2, 3].map((n) => u16(0x10 + n * 4) & 0x1ff),
  bgvofs: [0, 1, 2, 3].map((n) => u16(0x12 + n * 4) & 0x1ff),
  bldcnt: hex(u16(0x50)),
  bldalpha: hex(u16(0x52)),
  bldy: hex(u16(0x54) & 0xff, 2),
  vram_base64: Buffer.from(vram).toString('base64'),
  vram_sha256: sha256(vram),
  palette_base64: Buffer.from(palette).toString('base64'),
  palette_sha256: sha256(palette),
};

// 自身摘要：覆盖除 self_sha256 之外的全部字段，规范化（键按插入顺序，已是固定顺序）。
const body = JSON.stringify(payload);
payload.self_sha256 = sha256(Buffer.from(body, 'utf8'));

mkdirSync(dirname(outPath), {recursive: true});
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`写出 ${outPath}`);
console.log(`frame ${frames}`);
console.log(`dispcnt ${payload.dispcnt}  bldcnt ${payload.bldcnt}  bldalpha ${payload.bldalpha}  bldy ${payload.bldy}`);
payload.bgcnt.forEach((cnt, n) => {
  console.log(`BG${n} cnt ${cnt}  hofs ${payload.bghofs[n]}  vofs ${payload.bgvofs[n]}`);
});
console.log(`vram ${vram.length} B sha256 ${payload.vram_sha256}`);
console.log(`palette ${palette.length} B sha256 ${payload.palette_sha256}`);
console.log(`self_sha256 ${payload.self_sha256}`);
