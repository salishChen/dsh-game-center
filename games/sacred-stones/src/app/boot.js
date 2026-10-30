/**
 * 内核启动
 *
 * `@gba-kit/gba-emulator` 不带 BIOS，构造出来的机器停在「BIOS 已跑完、准备跳进卡带」那一刻的前一步。
 * 它把 BIOS 干的那几件事拆成了显式的两步，必须我们自己补：
 *   1. 按 BOOT_STACK_POINTERS 给每个 CPU 模式设好 SP（BIOS 在 IWRAM 顶按模式逐个设栈）
 *   2. 切到 SYS 模式，CPSR 置 SYS，PC 跳到卡带入口 0x08000000
 *
 * 不做这两步的现象：寄存器全 0、PC 恒 0、画面恒黑。这不是内核坏了，是我们没扮演 BIOS。
 * 参考：`@gba-kit/gba-browser/dist/emulator.js:86` 的同款做法。
 */

import {Gba, BOOT_STACK_POINTERS} from '@gba-kit/gba-emulator';
import {MODE_SYS} from '@gba-kit/arm-emulator/arm-cpu';

/** 卡带 ROM 起始地址（GBA 内存映射里的 ROM 区基址）。 */
export const ROM_ENTRY = 0x08000000;

/** GBA 卡带头最短长度：0x00–0xBF 是 Nintendo logo + 标题 + 校验区。 */
const MIN_ROM_BYTES = 0xC0;

/**
 * @param {Uint8Array} romBytes 卡带镜像
 * @returns {object} 已能直接 `runFrame()` 的内核实例
 */
export function bootKernel(romBytes) {
  if (!(romBytes instanceof Uint8Array)) throw new TypeError('bootKernel 需要 Uint8Array 形式的 ROM');
  if (romBytes.length < MIN_ROM_BYTES) throw new TypeError(`ROM 只有 ${romBytes.length} 字节，不像 GBA 镜像`);

  const gba = new Gba();
  gba.reset();
  gba.loadRom(romBytes);

  const cpu = gba.armCpu;
  if (!cpu) throw new Error('内核没有暴露 armCpu，无法扮演 BIOS 引导');

  for (const [mode, sp] of BOOT_STACK_POINTERS) {
    cpu.switchMode(mode);
    cpu.registers[13] = sp;
  }
  cpu.switchMode(MODE_SYS);
  cpu.cpsr = MODE_SYS;
  cpu.registers[15] = ROM_ENTRY;

  return gba;
}
