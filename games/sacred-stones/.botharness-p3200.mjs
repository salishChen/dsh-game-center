import {readFileSync} from 'node:fs';
import {bootKernel} from './src/app/boot.js';
import {parseBgcnt, renderTextBg} from './src/extract/bg-render.js';
import {renderObjLayer, parseObj} from './src/extract/obj-render.js';
import {parseBldcnt} from './src/extract/color.js';

const rom = new Uint8Array(readFileSync('../../artifacts/fe8-remake/fe8-zh.gba'));
const gba = bootKernel(rom);
for (let i = 0; i < 3199; i += 1) gba.runFrame();
const bus = gba.bus, mmio = bus.mmioRegisters;
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);
const dispcnt = u16(0x00), bldcnt = u16(0x50);
const bgcnt = [0,1,2,3].map(n => u16(0x08 + n*2));
const vram = Uint8Array.from(bus.vram), palette = Uint8Array.from(bus.palette), oam = Uint8Array.from(bus.oam);
gba.runFrame();
const fb = gba.ppu.getFramebuffer();
const [X,Y] = [139, 64];
const i = Y*240 + X;
const v = fb[i];
console.log('hardware', [v&0xff,(v>>8)&0xff,(v>>16)&0xff].join(','), 'dispcnt 0x'+dispcnt.toString(16), 'bldcnt 0x'+bldcnt.toString(16));
for (const n of [0,1,2,3]) {
  if (!((dispcnt >> (8+n)) & 1)) { console.log('BG'+n, 'off'); continue; }
  const img = renderTextBg({vram, palette, bgcnt: bgcnt[n], hofs: u16(0x10+n*4)&0x1ff, vofs: u16(0x12+n*4)&0x1ff, width: 240, height: 160});
  console.log('BG'+n, 'cnt 0x'+bgcnt[n].toString(16), 'prio', parseBgcnt(bgcnt[n]).priority, 'alpha', img.rgba[i*4+3], 'rgb', [img.rgba[i*4],img.rgba[i*4+1],img.rgba[i*4+2]].join(','));
}
const obj = renderObjLayer({oam, vram, palette, dispcnt, backdrop: null});
console.log('OBJ alpha', obj.rgba[i*4+3], 'rgb', [obj.rgba[i*4],obj.rgba[i*4+1],obj.rgba[i*4+2]].join(','), 'prio', obj.priorityMap[i]);
