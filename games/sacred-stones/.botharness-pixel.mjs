import {readFileSync} from 'node:fs';
import {bootKernel} from './src/app/boot.js';
import {parseBgcnt, renderTextBg, backdropColor} from './src/extract/bg-render.js';
import {parseBldcnt} from './src/extract/color.js';

const rom = new Uint8Array(readFileSync('../../artifacts/fe8-remake/fe8-zh.gba'));
const gba = bootKernel(rom);
for (let i = 0; i < 900; i += 1) gba.runFrame();
const bus = gba.bus, mmio = bus.mmioRegisters;
const u16 = (at) => mmio[at] | (mmio[at + 1] << 8);
const dispcnt = u16(0x00), bldcnt = u16(0x50);
const bgcnt = [0,1,2,3].map(n => u16(0x08 + n*2));
const vram = Uint8Array.from(bus.vram), palette = Uint8Array.from(bus.palette);
const bld = parseBldcnt(bldcnt);
const [X, Y] = [216, 8];
for (const n of [1,2,3]) {
  const img = renderTextBg({vram, palette, bgcnt: bgcnt[n], hofs: u16(0x10+n*4)&0x1ff, vofs: u16(0x12+n*4)&0x1ff, width: 240, height: 160});
  const at = (Y*240+X)*4;
  console.log('BG'+n, 'cnt 0x'+bgcnt[n].toString(16), 'alpha', img.rgba[at+3], 'rgb', [img.rgba[at],img.rgba[at+1],img.rgba[at+2]].join(','),
    'firstTarget', bld.targetsBg.includes(n), 'secondTarget', bld.secondTargetsBg.includes(n), 'prio', parseBgcnt(bgcnt[n]).priority);
}
const fb = gba.ppu.getFramebuffer();
const v = fb[Y*240+X];
console.log('hardware', [v & 0xff, (v>>8)&0xff, (v>>16)&0xff].join(','));
console.log('bld', JSON.stringify(bld), 'bldalpha 0x'+u16(0x52).toString(16));
