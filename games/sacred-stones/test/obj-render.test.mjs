import {test} from 'node:test';
import assert from 'node:assert/strict';

import {renderObjLayer, OBJ_MAX_SPRITES_PER_LINE, OBJ_MAX_PIXELS_PER_LINE} from '../src/extract/obj-render.js';

// 这一组钉两件事：
//   ① 两条**尚未被证伪**的硬件上限（每行 64 精灵 / 每行 1024 像素）默认必须关闭；
//   ② 一旦有人显式打开，行为要真的是"先到先得"，而不是静默丢精灵。

function makeOam(entries) {
  const oam = new Uint8Array(1024);
  for (const {index, attr0, attr1, attr2} of entries) {
    oam[index * 8 + 0] = attr0 & 0xff;
    oam[index * 8 + 1] = (attr0 >> 8) & 0xff;
    oam[index * 8 + 2] = attr1 & 0xff;
    oam[index * 8 + 3] = (attr1 >> 8) & 0xff;
    oam[index * 8 + 4] = attr2 & 0xff;
    oam[index * 8 + 5] = (attr2 >> 8) & 0xff;
  }
  return oam;
}

/** 造一块 8x8 全 1 的 OBJ 图块（4bpp），并给 OBJ 调色板 bank0 的 1 号色填红。 */
function makeVramAndPalette() {
  const vram = new Uint8Array(0x18000);
  const base = 0x10000; // OBJ 图块区起点
  vram.fill(0x11, base, base + 32);
  const palette = new Uint8Array(1024);
  palette[0x200 + 2] = 0x1f; // BGR555 0x001F = 纯红
  palette[0x200 + 3] = 0x00;
  return {vram, palette};
}

test('逐扫描线上限默认关闭：不给参数时两个 dropped 计数都是 0', () => {
  const {vram, palette} = makeVramAndPalette();
  const oam = makeOam([
    {index: 0, attr0: 0x0000, attr1: 0x0000, attr2: 0x0000},
    {index: 1, attr0: 0x0000, attr1: 0x0008, attr2: 0x0000},
  ]);
  const out = renderObjLayer({oam, vram, palette, dispcnt: 0x1000});
  assert.equal(out.dropped.overLimit, 0, '默认不因精灵数丢弃');
  assert.equal(out.dropped.overPixels, 0, '默认不因像素额度丢弃');
  assert.equal(out.paintedPixels, 128, '两个 8x8 精灵都真的画出来了');
});

test('上限常量本身的值：64 精灵 / 1024 像素（GBATEK 的硬件值）', () => {
  assert.equal(OBJ_MAX_SPRITES_PER_LINE, 64);
  assert.equal(OBJ_MAX_PIXELS_PER_LINE, 1024);
});

test('显式打开精灵数上限：最不优先的精灵被丢弃', () => {
  const {vram, palette} = makeVramAndPalette();
  const oam = makeOam([
    {index: 0, attr0: 0x0000, attr1: 0x0000, attr2: 0x0000}, // priority 0
    {index: 1, attr0: 0x0000, attr1: 0x0008, attr2: 0x0400}, // priority 1
    {index: 2, attr0: 0x0000, attr1: 0x0010, attr2: 0x0800}, // priority 2
  ]);
  const out = renderObjLayer({oam, vram, palette, dispcnt: 0x1000, maxSpritesPerLine: 2});
  assert.equal(out.dropped.overLimit > 0, true, '三个精灵里被丢了至少一个');
  const pxAt = (x, y) => out.rgba[(y * 240 + x) * 4 + 3];
  assert.equal(pxAt(16, 0), 0, 'priority 2 的精灵（x=16）被丢弃，没有画上');
  assert.notEqual(pxAt(0, 0), 0, 'priority 0 的精灵照常画');
});

test('显式打开像素额度：额度用完后该行不再绘制', () => {
  const {vram, palette} = makeVramAndPalette();
  const oam = makeOam([
    {index: 0, attr0: 0x0000, attr1: 0x0000, attr2: 0x0000},
    {index: 1, attr0: 0x0000, attr1: 0x0008, attr2: 0x0000},
  ]);
  const out = renderObjLayer({oam, vram, palette, dispcnt: 0x1000, maxPixelsPerLine: 8});
  // 每行额度 8 像素：第一个精灵（8 像素宽）就吃满了，第二个精灵整行没份
  assert.equal(out.paintedPixels, 8 * 8, '每行只画额度内的像素');
});
