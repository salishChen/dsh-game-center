/**
 * 外壳三件（启动 / 画面 / 键盘）的测试
 *
 * 这三件平时只能靠"打开页面看一眼"验证，那样一旦坏了没人知道坏在哪一层。
 * 这里用替身把每一层单独钉住：假 canvas 验像素搬运，假 EventTarget 验键位映射，
 * 真 ROM（有的话）验引导后画面确实不是全黑。
 */

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {bootKernel, ROM_ENTRY} from '../src/app/boot.js';
import {createRenderer, SCREEN_WIDTH, SCREEN_HEIGHT} from '../src/app/renderer.js';
import {createKeyboardInput, BUTTONS, KEY_MAP} from '../src/app/keyboard.js';

const ROM_PATH = fileURLToPath(new URL('../../../artifacts/fe8-remake/fe8-zh.gba', import.meta.url));
const hasRom = existsSync(ROM_PATH);

/** 假 canvas：只实现渲染器用到的那三个接口，记录最后一次 putImageData。 */
function fakeCanvas() {
  const sink = {last: null};
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        createImageData: (w, h) => ({width: w, height: h, data: new Uint8ClampedArray(w * h * 4)}),
        putImageData: (image) => {
          sink.last = image;
        },
      };
    },
  };
  return {canvas, sink};
}

/** 假事件目标：能注册/派发，不依赖 DOM。 */
function fakeTarget() {
  const handlers = new Map();
  return {
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      handlers.get(type)?.delete(fn);
    },
    dispatch(type, event) {
      for (const fn of handlers.get(type) ?? []) fn(event);
    },
    count(type) {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

test('boot: ROM 太小时直接拒绝，不构造内核', () => {
  assert.throws(() => bootKernel(new Uint8Array(8)), /不像 GBA 镜像/);
  assert.throws(() => bootKernel('not bytes'), /Uint8Array/);
});

test('boot: 引导后 PC 落在卡带入口，且能推进帧', {skip: hasRom ? false : '缺少 ROM 文件'}, () => {
  const rom = new Uint8Array(readFileSync(ROM_PATH));
  const gba = bootKernel(rom);
  assert.equal(gba.armCpu.registers[15], ROM_ENTRY, 'PC 应该被设到 0x08000000');
  for (let i = 0; i < 60; i += 1) gba.runFrame();
  assert.ok(gba.frameCount >= 60, '帧数应该推进');
});

test('boot: 引导后画面不是全黑（BIOS 漏做的事补齐了才有的现象）', {skip: hasRom ? false : '缺少 ROM 文件'}, () => {
  const rom = new Uint8Array(readFileSync(ROM_PATH));
  const gba = bootKernel(rom);
  for (let i = 0; i < 240; i += 1) gba.runFrame();
  const framebuffer = gba.ppu.getFramebuffer();
  assert.equal(framebuffer.length, SCREEN_WIDTH * SCREEN_HEIGHT);
  const distinct = new Set();
  for (let i = 0; i < framebuffer.length; i += 61) distinct.add(framebuffer[i]);
  assert.ok(distinct.size > 1, `画面采样只有 ${distinct.size} 种颜色，等于全黑`);
});

test('renderer: canvas 尺寸被强制成 GBA 分辨率', () => {
  const {canvas} = fakeCanvas();
  const renderer = createRenderer(canvas);
  assert.equal(canvas.width, SCREEN_WIDTH);
  assert.equal(canvas.height, SCREEN_HEIGHT);
  assert.equal(renderer.width, SCREEN_WIDTH);
});

test('renderer: 内核 framebuffer 的 0xAABBGGRR 字节序与 ImageData 一致，必须原样搬运', () => {
  const {canvas, sink} = fakeCanvas();
  const renderer = createRenderer(canvas);
  const framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  // 0xAABBGGRR：低字节是 R，小端下内存顺序就是 R,G,B,A —— 正好是 ImageData 要的顺序
  framebuffer[0] = 0xff0000ff; // R=255
  framebuffer[1] = 0xff00ff00; // G=255
  framebuffer[2] = 0xffff0000; // B=255
  assert.equal(renderer.draw(framebuffer), true);
  const bytes = sink.last.data;
  assert.deepEqual([...bytes.slice(0, 8)], [255, 0, 0, 255, 0, 255, 0, 255]);
  assert.deepEqual([...bytes.slice(8, 12)], [0, 0, 255, 255]);
});

test('renderer: framebuffer 长度不对时不动 canvas，返回 false', () => {
  const {canvas, sink} = fakeCanvas();
  const renderer = createRenderer(canvas);
  assert.equal(renderer.draw(new Uint32Array(10)), false);
  assert.equal(sink.last, null);
});

test('keyboard: 映射表覆盖 GBA 十颗键，重复注册不会双发', () => {
  const buttons = new Set(Object.values(KEY_MAP).map((name) => BUTTONS[name]));
  assert.deepEqual([...buttons].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const target = fakeTarget();
  const pressed = [];
  const released = [];
  const input = createKeyboardInput({
    kernel: {press: (b) => pressed.push(b), release: (b) => released.push(b)},
    target,
  });

  const event = {code: 'KeyZ', preventDefault() {}};
  target.dispatch('keydown', event);
  target.dispatch('keydown', {code: 'KeyZ', preventDefault() {}}); // 长按的自动重复
  assert.deepEqual(pressed, [BUTTONS.A], '长按不应该重复 press');
  assert.deepEqual(input.held, ['A']);

  target.dispatch('keyup', {code: 'KeyZ', preventDefault() {}});
  target.dispatch('keyup', {code: 'KeyZ', preventDefault() {}});
  assert.deepEqual(released, [BUTTONS.A]);
  assert.deepEqual(input.held, []);
});

test('keyboard: 失焦释放全部按键（否则切窗口回来角色自己在走）', () => {
  const target = fakeTarget();
  const pressed = [];
  const released = [];
  createKeyboardInput({
    kernel: {press: (b) => pressed.push(b), release: (b) => released.push(b)},
    target,
  });
  target.dispatch('keydown', {code: 'ArrowRight', preventDefault() {}});
  target.dispatch('keydown', {code: 'KeyZ', preventDefault() {}});
  assert.equal(pressed.length, 2);
  target.dispatch('blur', {});
  assert.deepEqual(released.sort((a, b) => a - b), [BUTTONS.A, BUTTONS.Right].sort((a, b) => a - b));
});

test('keyboard: 不认识的键不拦截默认行为（不要吃掉浏览器快捷键）', () => {
  const target = fakeTarget();
  const input = createKeyboardInput({kernel: {press() {}, release() {}}, target});
  let prevented = false;
  target.dispatch('keydown', {code: 'KeyP', preventDefault: () => { prevented = true; }});
  assert.equal(prevented, false);
  input.dispose();
  assert.equal(target.count('keydown'), 0, 'dispose 之后不该留监听');
});
