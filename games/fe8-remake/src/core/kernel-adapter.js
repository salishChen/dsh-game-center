/**
 * 内核适配层
 *
 * 把任何一个 GBA 内核（当前是 `@gba-kit/gba-emulator` 0.8.0，MIT）收敛成我们需要的四件事：
 *   1. 内存读写 `io`（给 memory-access 用）
 *   2. `snapshot()/restore()`（savestate，纯对象 + TypedArray，可进 IndexedDB）
 *   3. 按键 `press/release`（游戏里没有真实键盘，靠它驱动）
 *   4. 帧推进 `runFrame()` 与取画面 `framebuffer()`
 *
 * 为什么要有这一层而不是直接调内核：
 * 换内核（比如哪天 mGBA 的 wasm 更准）时只改这个文件，游戏代码不动。
 */

/**
 * @param {object} gba 内核实例，需要 `bus.read8/16/32`、`bus.write8/16`、`serialize`、`deserialize`、`runFrame`、`ppu.getFramebuffer`
 */
export function createKernelAdapter(gba) {
  if (!gba || !gba.bus) throw new TypeError('createKernelAdapter 需要内核实例（含 bus）');
  for (const method of ['serialize', 'deserialize', 'runFrame']) {
    if (typeof gba[method] !== 'function') throw new TypeError(`内核缺少 ${method}()`);
  }

  const bus = gba.bus;
  return {
    raw: gba,

    io: {
      read8: (address) => bus.read8(address),
      read16: (address) => bus.read16(address),
      read32: (address) => bus.read32(address),
      write8: (address, value) => bus.write8(address, value),
      write16: (address, value) => bus.write16(address, value),
    },

    /**
     * 内核 savestate。用 structuredClone 复制一份，避免调用方改了返回值把内核状态带坏。
     * 注意：**不要 JSON 往返**——TypedArray 会退化成普通对象，restore 直接失败或静默错。
     */
    snapshot() {
      return structuredClone(gba.serialize());
    },

    restore(snapshot) {
      gba.deserialize(structuredClone(snapshot));
    },

    press(button) {
      gba.pressButton(button);
    },

    release(button) {
      gba.releaseButton(button);
    },

    /** @returns {'done'|'stopped'|'halted'|'stalled'} */
    runFrame() {
      return gba.runFrame();
    },

    framebuffer() {
      return gba.ppu.getFramebuffer();
    },

    get frameCount() {
      return gba.frameCount;
    },
  };
}
