/**
 * 键盘 → GBA 按键
 *
 * 键位是 GBA 主机那套（不是 GBA 模拟器常见的一套），理由：这游戏原本就为这套键设计，
 * 玩家手感和当年一致。WASD 与方向键都映射到方向，Z/X 是 A/B（GBA 上 A 在右边）。
 *
 * 按键值用的是 KEYINPUT 的位号，与内核 `pressButton/releaseButton` 期望的 GbaButton 枚举值一致：
 * A=0 B=1 Select=2 Start=3 Right=4 Left=5 Up=6 Down=7 R=8 L=9。
 * 这里不 import 内核的 `const enum`（编译期常量，运行时可能不存在），用注释把来源钉住即可。
 */

export const BUTTONS = Object.freeze({
  A: 0,
  B: 1,
  Select: 2,
  Start: 3,
  Right: 4,
  Left: 5,
  Up: 6,
  Down: 7,
  R: 8,
  L: 9,
});

/** KeyboardEvent.code → 按钮名。用 code 不用 key：换输入法/大写锁定都不影响。 */
export const KEY_MAP = Object.freeze({
  KeyZ: 'A',
  KeyX: 'B',
  Enter: 'Start',
  ShiftRight: 'Select',
  ShiftLeft: 'Select',
  ArrowRight: 'Right',
  ArrowLeft: 'Left',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  KeyD: 'Right',
  KeyA: 'Left',
  KeyW: 'Up',
  KeyS: 'Down',
  KeySemicolon: 'R',
  KeyE: 'R',
  KeyQ: 'L',
  Backspace: 'L',
});

/**
 * @param {object} options
 * @param {{press:Function, release:Function}} options.kernel 内核适配层
 * @param {EventTarget} [options.target] 默认 window
 * @param {(name:string) => void} [options.onChange] 按键状态变化回调（调试/UI 用）
 */
export function createKeyboardInput(options) {
  const kernel = options?.kernel;
  if (!kernel || typeof kernel.press !== 'function') throw new TypeError('createKeyboardInput 需要 kernel.press/release');
  const target = options.target ?? globalThis;
  const onChange = options.onChange;
  const held = new Set();

  function press(name) {
    const code = BUTTONS[name];
    if (code === undefined || held.has(name)) return;
    held.add(name);
    kernel.press(code);
    onChange?.(name);
  }

  function release(name) {
    const code = BUTTONS[name];
    if (code === undefined || !held.has(name)) return;
    held.delete(name);
    kernel.release(code);
    onChange?.(name);
  }

  function releaseAll() {
    for (const name of [...held]) release(name);
  }

  function onKeyDown(event) {
    const name = KEY_MAP[event.code];
    if (name === undefined) return;
    // 方向键/空格会滚页面，这里必须吃掉
    event.preventDefault();
    press(name);
  }

  function onKeyUp(event) {
    const name = KEY_MAP[event.code];
    if (name === undefined) return;
    event.preventDefault();
    release(name);
  }

  /** 失焦时把按住的键全松开，否则切窗口回来会发现角色自己在走。 */
  function onBlur() {
    releaseAll();
  }

  target.addEventListener('keydown', onKeyDown, {passive: false});
  target.addEventListener('keyup', onKeyUp, {passive: false});
  target.addEventListener('blur', onBlur);

  return {
    press,
    release,
    releaseAll,
    get held() {
      return [...held];
    },
    dispose() {
      releaseAll();
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    },
  };
}
