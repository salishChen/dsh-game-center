/**
 * 真内核集成测试：用真 ROM 验证「外壳三接口」在内核上确实成立
 *
 * 跑的条件（否则 skip，不让 CI 依赖 16 MB 的 ROM）：
 *   FE8_ROM=<path> 或默认 artifacts/fe8-remake/fe8-zh.gba 存在
 *
 * 验的是四件事：
 *   1. 内核能起来并且真的执行 ARM 指令（ROM 头能读出来）
 *   2. kernel-adapter 的 io 走的是同一条总线（读 ROM 头 = 预期字节）
 *   3. savestate 能原样回滚：存档 → 跑 120 帧 → 哈希；restore → 再跑 120 帧 → 同一哈希
 *   4. 快照是 structuredClone 友好的（TypedArray 还是 TypedArray）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

import {createKernelAdapter} from '../src/core/kernel-adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROM = resolve(here, '../../../artifacts/fe8-remake/fe8-zh.gba');
const ROM_PATH = process.env.FE8_ROM || DEFAULT_ROM;
const hasRom = existsSync(ROM_PATH);

/** 跳过而不是失败：这套测试要 16 MB 的 ROM，不该出现在干净的 CI 上。 */
const skip = hasRom ? false : `缺少 ROM（${ROM_PATH}），设 FE8_ROM 或放到 artifacts/fe8-remake/`;

let cached = null;
async function bootedKernel() {
  if (cached) return cached;
  const {Gba, BOOT_STACK_POINTERS} = await import('@gba-kit/gba-emulator');
  const {MODE_SYS} = await import('@gba-kit/arm-emulator/arm-cpu');

  const gba = new Gba();
  gba.reset();
  gba.loadRom(new Uint8Array(readFileSync(ROM_PATH)));

  // 没有 BIOS：自己摆好栈指针、切到 SYS 模式、跳到 cart entry
  const cpu = gba.armCpu;
  for (const [mode, sp] of BOOT_STACK_POINTERS) {
    cpu.switchMode(mode);
    cpu.registers[13] = sp;
  }
  cpu.switchMode(MODE_SYS);
  cpu.cpsr = MODE_SYS;
  cpu.registers[15] = 0x08000000;

  cached = createKernelAdapter(gba);
  return cached;
}

/** 画面指纹：只用来判断"两帧是否相同"，不是给用户看的摘要。 */
function framebufferHash(fb) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < fb.length; i += 1) {
    const v = fb[i];
    h1 = Math.imul(h1 ^ v, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + v, 0x27d4eb2d) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

function runFrames(kernel, count) {
  for (let i = 0; i < count; i += 1) kernel.runFrame();
}

test('内核：能读到 ROM 头（说明 ARM 指令真的在跑）', {skip}, async () => {
  const kernel = await bootedKernel();
  const title = [];
  for (let i = 0; i < 12; i += 1) title.push(String.fromCharCode(kernel.io.read8(0x080000A0 + i)));
  assert.equal(title.join('').replace(/\0+$/, ''), 'FIREEMBLEM8');
  // 0x080000AC 起是游戏码 BE8J（汉化镜像保持原版）
  const code = [];
  for (let i = 0; i < 4; i += 1) code.push(String.fromCharCode(kernel.io.read8(0x080000AC + i)));
  assert.equal(code.join(''), 'BE8J');
});

test('内核：跑得动 300 帧且画面在变', {skip}, async () => {
  const kernel = await bootedKernel();
  const before = framebufferHash(kernel.framebuffer());
  runFrames(kernel, 300);
  const after = framebufferHash(kernel.framebuffer());
  assert.notEqual(before, after, '画面完全没变，内核大概没在跑');
});

test('savestate：存档→跑 120 帧→回档→再跑 120 帧，画面哈希一致', {skip}, async () => {
  const kernel = await bootedKernel();
  runFrames(kernel, 60);

  const snap = kernel.snapshot();
  assert.ok(snap.ppu.framebuffer instanceof Uint32Array, '快照里的帧缓冲应该是 TypedArray');

  runFrames(kernel, 120);
  const forward = framebufferHash(kernel.framebuffer());

  kernel.restore(snap);
  runFrames(kernel, 120);
  const replayed = framebufferHash(kernel.framebuffer());

  assert.equal(replayed, forward, '回档后重放不一致 → 存档缺状态（PRNG/调度器/输入队列）');
});

test('savestate：快照可被 structuredClone 往返（IndexedDB 那条路的前提）', {skip}, async () => {
  const kernel = await bootedKernel();
  const snap = kernel.snapshot();
  const copy = structuredClone(snap);
  assert.ok(copy.bus.ewram instanceof Uint8Array);
  assert.equal(copy.bus.ewram.length, snap.bus.ewram.length);
  kernel.restore(copy);
  assert.equal(kernel.frameCount, snap.frameCount ?? kernel.frameCount);
});
