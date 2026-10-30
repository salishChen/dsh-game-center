// 颜色口径与颜色特效的单元测试。
//
// 这些期望值都是**手算**的（GBATEK 的整数公式），不是从实现里跑出来再抄回去的：
//   ALPHA    : (top*EVA + back*EVB) >> 4
//   BRIGHTEN : top + ((31 - top) * EVY >> 4)
//   DARKEN   : top - (top * EVY >> 4)
// 边界值 16 表示"全部"，不是 1.0 的定点写法问题：`>> 4` 除以 16，16 时刚好等于原值。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  BLEND_MODE,
  blend5,
  blend8,
  expand5,
  parseBldcnt,
  to5,
  write5To,
} from '../src/extract/color.js';

test('expand5：0→0、31→255，中间值复制高 3 位（31 必须到 255）', () => {
  assert.equal(expand5(0), 0);
  assert.equal(expand5(31), 255);
  assert.equal(expand5(1), 8 | 0); // 1<<3 | 1>>2 = 8
  assert.equal(expand5(16), 128 | 4); // 128 | 4
  // 如果只写 v<<3，31 会变成 248，纯白永远到不了 255
  assert.notEqual(expand5(31), 248);
});

test('to5 是 expand5 的精确逆运算', () => {
  for (let v = 0; v < 32; v += 1) assert.equal(to5(expand5(v)), v);
});

test('write5To 把 5 位三元组写成 RGBA 四字节', () => {
  const out = new Uint8Array(4);
  write5To(out, 0, [31, 0, 16]);
  assert.deepEqual([...out], [255, 0, 132, 255]);
});

test('blend5 ALPHA：EVA=16/EVB=0 等于原色，EVA=0/EVB=16 等于第二目标', () => {
  const top = [20, 10, 5];
  const back = [4, 2, 1];
  assert.deepEqual(blend5(top, back, {mode: BLEND_MODE.ALPHA, eva: 16, evb: 0}), top);
  assert.deepEqual(blend5(top, back, {mode: BLEND_MODE.ALPHA, eva: 0, evb: 16}), back);
});

test('blend5 ALPHA：8/8 是两者平均，整数截断（不是四舍五入）', () => {
  // (20*8 + 4*8) >> 4 = 192>>4 = 12
  // (10*8 + 2*8) >> 4 = 96>>4 = 6
  // (5*8 + 1*8) >> 4 = 48>>4 = 3
  assert.deepEqual(blend5([20, 10, 5], [4, 2, 1], {mode: BLEND_MODE.ALPHA, eva: 8, evb: 8}), [12, 6, 3]);
});

test('blend5 ALPHA：EVA+EVB>16 时按通道上限 31 截断，不溢出', () => {
  assert.deepEqual(blend5([31, 31, 31], [31, 31, 31], {mode: BLEND_MODE.ALPHA, eva: 16, evb: 16}), [31, 31, 31]);
});

test('blend5 BRIGHTEN：EVY=16 到纯白，EVY=0 不变', () => {
  assert.deepEqual(blend5([10, 20, 31], [0, 0, 0], {mode: BLEND_MODE.BRIGHTEN, evy: 16}), [31, 31, 31]);
  assert.deepEqual(blend5([10, 20, 31], [0, 0, 0], {mode: BLEND_MODE.BRIGHTEN, evy: 0}), [10, 20, 31]);
});

test('blend5 BRIGHTEN：EVY=8 是"到白色的一半"', () => {
  // 0 + ((31-0)*8>>4) = 15；31 + ((0)*8>>4) = 31
  assert.deepEqual(blend5([0, 31, 16], [0, 0, 0], {mode: BLEND_MODE.BRIGHTEN, evy: 8}), [15, 31, 23]);
});

test('blend5 DARKEN：EVY=16 到黑，EVY=0 不变，中间值向下取整', () => {
  assert.deepEqual(blend5([10, 20, 31], [0, 0, 0], {mode: BLEND_MODE.DARKEN, evy: 16}), [0, 0, 0]);
  assert.deepEqual(blend5([10, 20, 31], [0, 0, 0], {mode: BLEND_MODE.DARKEN, evy: 0}), [10, 20, 31]);
  // 20 - (20*8>>4) = 20 - 10 = 10；31 - (31*8>>4) = 31 - 15 = 16
  assert.deepEqual(blend5([10, 20, 31], [0, 0, 0], {mode: BLEND_MODE.DARKEN, evy: 8}), [5, 10, 16]);
});

test('blend5 无特效时原样返回（不碰第二目标）', () => {
  assert.deepEqual(blend5([1, 2, 3], [30, 30, 30], {mode: BLEND_MODE.NONE}), [1, 2, 3]);
});

test('blend8 与 blend5 在整数倍色彩上同构：31→255 的同一式子', () => {
  // 8 位域：255 - (255*8>>4) = 255 - 127 = 128；5 位域对应 31-15=16 → 132
  assert.deepEqual(blend8([255, 0, 128], [0, 0, 0], {mode: BLEND_MODE.DARKEN, evy: 8}), [128, 0, 64]);
  assert.deepEqual(blend8([0, 0, 0], [0, 0, 0], {mode: BLEND_MODE.BRIGHTEN, evy: 16}), [255, 255, 255]);
});

test('parseBldcnt：第二目标在 bit8..13，不是 bit0..5', () => {
  // bit2 = 第一目标 BG2；bit13 = 第二目标 BD；bit6..7 = 1（alpha）
  const fx = parseBldcnt((1 << 2) | (1 << 13) | (1 << 6));
  assert.deepEqual(fx.targetsBg, [2]);
  assert.equal(fx.secondTargetBackdrop, true);
  assert.equal(fx.mode, BLEND_MODE.ALPHA);
  // 只设 bit5（第一目标 BD）时，第二目标是空的 —— 这个混淆曾让 6,241 个像素全红
  const wrong = parseBldcnt((1 << 2) | (1 << 5) | (1 << 6));
  assert.equal(wrong.targetBackdrop, true);
  assert.equal(wrong.secondTargetBackdrop, false);
});

test('parseBldcnt：特效模式 2/3 与 OBJ 段', () => {
  const fx = parseBldcnt((1 << 4) | (1 << 12) | (3 << 6));
  assert.equal(fx.targetObj, true);
  assert.equal(fx.secondTargetObj, true);
  assert.equal(fx.mode, BLEND_MODE.DARKEN);
});

// BLDCNT 的位展开一律由脚本打印后复制，不靠手算——同一个下午在 bit13 和 bits8-13 上
// 各错一次，说明"手算位布局"这个动作本身就不该存在。
test('parseBldcnt(0x0c42) 的结构必须被断言，而不是被讨论', () => {
  const bld = parseBldcnt(0x0c42);
  assert.deepEqual(bld.targetsBg, [1], '第一目标 BG1');
  assert.equal(bld.mode, 1, 'alpha');
  assert.deepEqual(bld.secondTargetsBg, [2, 3], '第二目标 BG2|BG3（不是 BG0|BG1）');
  assert.equal(bld.secondTargetBackdrop, false, 'BD（bit13）未置');
});

test('parseBldcnt(0x0340) 的位展开（帧 3200 实测值）', () => {
  const bld = parseBldcnt(0x0340);
  assert.deepEqual(bld.targetsBg, [], '第一目标为空');
  assert.equal(bld.mode, 1);
  assert.deepEqual(bld.secondTargetsBg, [0, 1], '第二目标 BG0|BG1');
});
