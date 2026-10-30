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
// 寄存器时序（本项目踩过的坑，务必保持）：
// 游戏在 VBlank 里写 DISPCNT/BGxCNT/BGxHOFS/BGxVOFS/BLDCNT，所以"跑完第 N 帧之后读到的寄存器"
// 是给**第 N+1 帧**用的。要让 dump 里寄存器和"第 N 帧那张图"配得上，必须：
//   跑 N-1 帧 → 快照寄存器/内存 → 再跑 1 帧（得到第 N 帧的画面）
// 之前写成"跑 N 帧再快照"，dump 出来的寄存器比图晚一帧，静态渲染器据此拼出来的就是错帧。
for (let i = 0; i < frames - 1; i += 1) gba.runFrame();

const bus = gba.bus;
const mmio = bus.mmioRegisters;
// mmioRegisters 是 Uint8Array（1024 字节，按字节寻址）：
// DISPCNT 在 byte 0..1（小端）、BGxCNT 在 0x08 + n*2、BGxHOFS 在 0x10 + n*4、BGxVOFS 在 0x12 + n*4、
// BLDCNT 在 0x50、BLDALPHA 0x52、BLDY 0x54。按"寄存器序号"读会读成另一件事（踩过）。
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);

// vram/palette 必须与寄存器来自同一时刻：这里取的是"第 N 帧渲染所用"的那一份。
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

// 自身摘要的定义必须写死、且能被任何语言独立复核：
//
//   self_sha256 = sha256( 文件字节，其中 self_sha256 字段的值被替换成 64 个 '0' )
//
// 不用"去掉该字段再序列化"：那样依赖键序与缩进，换个语言重算很可能对不上，
// 而一个对不上的自校验字段比没有它更坏——它长得像"已校验"。
const ZEROS = '0'.repeat(64);
const placeholderText = `${JSON.stringify({...payload, self_sha256: ZEROS}, null, 2)}\n`;
payload.self_sha256 = sha256(Buffer.from(placeholderText, 'utf8'));
const text = placeholderText.replace(ZEROS, payload.self_sha256);

// 写完前自检：把真值换回占位符，必须重新得出同一个摘要。
if (sha256(Buffer.from(text.replace(payload.self_sha256, ZEROS), 'utf8')) !== payload.self_sha256) {
  console.error('自校验失败：替换回占位符后摘要不一致');
  process.exit(1);
}

mkdirSync(dirname(outPath), {recursive: true});
writeFileSync(outPath, text);

console.log(`写出 ${outPath}`);
console.log(`frame ${frames}`);
console.log(`dispcnt ${payload.dispcnt}  bldcnt ${payload.bldcnt}  bldalpha ${payload.bldalpha}  bldy ${payload.bldy}`);
payload.bgcnt.forEach((cnt, n) => {
  console.log(`BG${n} cnt ${cnt}  hofs ${payload.bghofs[n]}  vofs ${payload.bgvofs[n]}`);
});
console.log(`vram ${vram.length} B sha256 ${payload.vram_sha256}`);
console.log(`palette ${palette.length} B sha256 ${payload.palette_sha256}`);
console.log(`self_sha256 ${payload.self_sha256}`);
