import {readFileSync} from 'node:fs';
import {bootKernel} from './src/app/boot.js';
import {parseObj, objTileAddress} from './src/extract/obj-render.js';

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
const px = (x, y) => { const v = fb[y * 240 + x]; return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]; };

const oam = Uint8Array.from(bus.oam);
const vram = Uint8Array.from(bus.vram);
const palette = Uint8Array.from(bus.palette);

// 找一个较大的可见精灵
let best = null;
for (let i = 0; i < 128; i += 1) {
  const o = parseObj(oam[i*8]|(oam[i*8+1]<<8), oam[i*8+2]|(oam[i*8+3]<<8), oam[i*8+4]|(oam[i*8+5]<<8));
  if (o.hide || !o.dimsValid) continue;
  const area = o.width * o.height;
  if (!best || area > best.area) best = {i, o, area};
}
const {i, o} = best;
console.log('sprite', i, 'size', o.width + 'x' + o.height, 'x', o.x, 'y', o.y, 'tile', '0x' + o.tileIndex.toString(16), 'palbank', o.paletteBank, 'prio', o.priority, '8bpp', o.colorMode8bpp);
for (const oneDim of [true, false]) {
  const addr = objTileAddress(o, 0, 0, oneDim);
  const bytes = [...vram.subarray(addr, addr + 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log('  addr(1D=' + oneDim + ')', '0x' + addr.toString(16), bytes);
}
// 该精灵左上角在屏幕上的硬件像素
console.log('  hw pixel at sprite corner', '(', o.x, o.y, ') =', px(o.x, o.y));
console.log('  bg pixel (0,0) =', px(0, 0), ' palette[0..8] =', [...palette.subarray(0, 8)]);
console.log('  obj palette start 0x200..0x208 =', [...palette.subarray(0x200, 0x208)]);
