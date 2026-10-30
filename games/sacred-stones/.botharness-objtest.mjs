import {readFileSync} from 'node:fs';
import {bootKernel} from './src/app/boot.js';
import {renderObjLayer, parseObj} from './src/extract/obj-render.js';
import {backdropColor} from './src/extract/bg-render.js';
import {compareFrames} from './scripts/compare-frame.mjs';

const rom = new Uint8Array(readFileSync('../../artifacts/fe8-remake/fe8-zh.gba'));
const gba = bootKernel(rom);
for (let i = 0; i < 3200; i += 1) gba.runFrame();
const bus = gba.bus;
const mmio = bus.mmioRegisters;
const read16 = (o) => mmio[o] | (mmio[o + 1] << 8);
const write16 = (o, v) => { mmio[o] = v & 0xff; mmio[o + 1] = (v >> 8) & 0xff; };
const dispcnt = read16(0x00);
write16(0x00, (dispcnt & 0x7) | (1 << 12));
write16(0x50, 0);
for (let y = 0; y < 160; y += 1) gba.ppu.renderScanline(y, bus);
const fb = gba.ppu.getFramebuffer();
const oracle = {width: 240, height: 160, rgba: new Uint8Array(Buffer.from(fb.buffer, fb.byteOffset, fb.byteLength))};

const oam = Uint8Array.from(bus.oam);
const vram = Uint8Array.from(bus.vram);
const palette = Uint8Array.from(bus.palette);
const backdrop = backdropColor(palette);

// 诊断：可见精灵的属性统计 + mine/oracle 的"非背景"掩码对比
{
  let n8 = 0, n16 = 0, aff = 0;
  for (let i = 0; i < 128; i += 1) {
    const o = parseObj(oam[i*8]|(oam[i*8+1]<<8), oam[i*8+2]|(oam[i*8+3]<<8), oam[i*8+4]|(oam[i*8+5]<<8));
    if (o.hide || !o.dimsValid) continue;
    if (o.colorMode8bpp) n8 += 1; else n16 += 1;
    if (o.affine) aff += 1;
  }
  console.log('visible 8bpp', n8, '16bpp', n16, 'affine', aff, 'dispcnt', '0x'+dispcnt.toString(16));
  const mine = renderObjLayer({oam, vram, palette, dispcnt, backdrop});
  const maskMine = [], maskOracle = [];
  const bd = backdrop.join(',');
  let mineN = 0, oracleN = 0, both = 0;
  for (let i = 0; i < 240*160; i += 1) {
    const m = mine.rgba[i*4+3] !== 0 ? 1 : 0;
    const o = oracle.rgba[i*4] !== backdrop[0] || oracle.rgba[i*4+1] !== backdrop[1] || oracle.rgba[i*4+2] !== backdrop[2] ? 1 : 0;
    mineN += m; oracleN += o; both += (m && o) ? 1 : 0;
  }
  console.log('mask mine', mineN, 'oracle', oracleN, 'overlap', both);
}

for (const oneDim of [true, false]) {
  const dc = oneDim ? (dispcnt | 0x40) : (dispcnt & ~0x40);
  const mine = renderObjLayer({oam, vram, palette, dispcnt: dc, backdrop});
  const r = compareFrames(mine, oracle, {tolerance: 0, quantizeBits: 3});
  console.log('oneDim', oneDim, 'diff', r.diffPixels, 'ratio', r.ratio.toFixed(4));
}
