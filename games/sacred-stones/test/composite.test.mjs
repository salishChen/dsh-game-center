import {test} from 'node:test';
import assert from 'node:assert/strict';

import {shouldBlend, belowColorFor} from '../src/extract/composite.js';

// 这一组用例钉的是"列表级 vs 逐像素"的分界。
// 背景：帧 900 的 BLDCNT = 0x0c42，第二目标列表 = BG2|BG3（非空），
// 但有 1,049 个像素上这两层都透明——按列表级判断会在这 1,049 个像素上多混。

test('第一目标 + 下方是第二目标层 ⇒ 混合', () => {
  assert.equal(shouldBlend({topIsFirst: true, belowExists: true, belowIsSecond: true, backdropInSecond: false}), true);
});

test('不是第一目标的层永远不参与混合', () => {
  assert.equal(shouldBlend({topIsFirst: false, belowExists: true, belowIsSecond: true, backdropInSecond: true}), false);
});

test('第二目标列表非空、但该像素下方没有第二目标层 ⇒ 不混合（1,049 个像素的情形）', () => {
  assert.equal(shouldBlend({topIsFirst: true, belowExists: true, belowIsSecond: false, backdropInSecond: false}), false);
});

test('下方全透明、但 BD 位让背景色参与 ⇒ 混合（与上一条互为两侧）', () => {
  assert.equal(shouldBlend({topIsFirst: true, belowExists: false, belowIsSecond: false, backdropInSecond: true}), true);
});

test('下方全透明且 BD 未置 ⇒ 不混合（不是"和黑色混"）', () => {
  assert.equal(shouldBlend({topIsFirst: true, belowExists: false, belowIsSecond: false, backdropInSecond: false}), false);
});

test('下方存在的层不属于第二目标、也不属于第一目标 ⇒ 不混合', () => {
  assert.equal(shouldBlend({topIsFirst: true, belowExists: true, belowIsSecond: false, backdropInSecond: false}), false);
});

test('belowColorFor：有层取层色，无层取背景色', () => {
  assert.deepEqual(belowColorFor({below: [1, 2, 3], backdrop: [9, 9, 9]}), [1, 2, 3]);
  assert.deepEqual(belowColorFor({below: null, backdrop: [9, 9, 9]}), [9, 9, 9]);
});
