import {readFileSync} from 'node:fs';
import {bootKernel} from './src/app/boot.js';
const rom = new Uint8Array(readFileSync('../../artifacts/fe8-remake/fe8-zh.gba'));
const gba = bootKernel(rom);
const snap = () => {
  const m = gba.bus.mmioRegisters;
  return [0x00,0x08,0x0a,0x0c,0x0e,0x10,0x12,0x14,0x16,0x18,0x1a,0x50,0x52,0x54].map(o => m[o] | (m[o+1]<<8)).join(',');
};
for (let i = 0; i < 900; i += 1) gba.runFrame();
let stable = 0;
for (let i = 0; i < 12; i += 1) {
  const before = snap();
  gba.runFrame();
  const after = snap();
  console.log('frame', 901 + i, before === after ? 'stable' : 'changed');
  if (before === after) { stable = 901 + i; break; }
}
console.log('first stable frame after 900:', stable);
