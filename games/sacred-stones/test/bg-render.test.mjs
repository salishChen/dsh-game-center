import test from 'node:test';
import assert from 'node:assert/strict';

import {renderTextBg, flattenOnBackdrop, parseBgcnt, mapDimensions, backdropColor} from '../src/extract/bg-render.js';

// 这些用例的期望值全部手算，不拿实现输出当期望值——否则只是"我同意我自己"。
const SCREEN_BASE = 0x800; // BGxCNT screenBase 字段第 1 档 = 0x800
const CHAR_BASE = 0x0000;

const makeVram = () => new Uint8Array(0x18000);
const makePalette = () => {
  const palette = new Uint8Array(512);
  // bank0 的 1 号色 = 纯红（BGR555 0x001F），每 bank 占 32 字节
  palette[2] = 0x1f;
  palette[3] = 0x00;
  // bank1 的 1 号色 = 纯红
  palette[32 + 2] = 0x1f;
  palette[32 + 3] = 0x00;
  // bank2 的 1 号色 = 纯绿（BGR555 0x03E0）
  palette[64 + 2] = 0xe0;
  palette[64 + 3] = 0x03;
  return palette;
};

const y4 = (level) => (level << 3) | (level >> 2); // 5 位 → 8 位

// 4bpp 图块：把一个 8x8 全填成 index 1（每字节 0x11）
const fillTile4bpp = (vram, tileIndex, byteValue) => {
  const base = CHAR_BASE + tileIndex * 32;
  vram.fill(byteValue, base, base + 32);
};

const setEntry = (vram, tileX, tileY, entry) => {
  const addr = SCREEN_BASE + (tileY * 32 + tileX) * 2;
  vram[addr] = entry & 0xff;
  vram[addr + 1] = (entry >> 8) & 0xff;
};

test('BGxCNT 位域：charBase/screenBase 是"档位 × 步长"，不是原始字节', () => {
  // 0x1d0a：priority 2、charBase 档 2(=0x8000)、4bpp、screenBase 档 0x1d(=0xE800)、size 0
  const cfg = parseBgcnt(0x1d0a);
  assert.equal(cfg.priority, 2);
  assert.equal(cfg.charBase, 0x8000);
  assert.equal(cfg.colorMode8bpp, 0);
  assert.equal(cfg.screenBase, 0xe800);
  assert.equal(cfg.size, 0);
});

test('地图尺寸：size 1 是 64x32，不是 32x64，也不是把行列都翻倍', () => {
  assert.deepEqual(mapDimensions(0), {cols: 32, rows: 32});
  assert.deepEqual(mapDimensions(1), {cols: 64, rows: 32});
  assert.deepEqual(mapDimensions(2), {cols: 32, rows: 64});
  assert.deepEqual(mapDimensions(3), {cols: 64, rows: 64});
});

test('4bpp 基本绘制：地图指向 index 1 的图块 + bank 1，颜色是调色板里的红', () => {
  const vram = makeVram();
  const palette = makePalette();
  fillTile4bpp(vram, 1, 0x11);
  setEntry(vram, 0, 0, 0x1001); // bank 1, tileIndex 1
  const bgcnt = (1 << 8) | 0; // screenBase 0x800, charBase 0, 4bpp, size 0
  const out = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  const pixel = (x, y) => [...out.rgba.subarray((y * 240 + x) * 4, (y * 240 + x) * 4 + 4)];
  assert.deepEqual(pixel(0, 0), [y4(31), y4(0), y4(0), 255]);
  assert.deepEqual(pixel(7, 7), [y4(31), y4(0), y4(0), 255]);
  // 地图上只有 (0,0) 这一格有条目，其余图块号 0 且像素为 0 → 透明
  assert.equal(pixel(8, 0)[3], 0);
  assert.ok(out.transparentPixels > 0);
});

test('调色板 bank 来自地图条目高 4 位：同一条目换 bank，颜色跟着换', () => {
  const vram = makeVram();
  const palette = makePalette();
  fillTile4bpp(vram, 1, 0x11);
  const bgcnt = (1 << 8) | 0;
  setEntry(vram, 0, 0, 0x1001); // bank 1 → 红
  const red = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  setEntry(vram, 0, 0, 0x2001); // bank 2 → 绿
  const green = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  assert.equal(red.rgba[0], y4(31));
  assert.equal(green.rgba[1], y4(31), 'bank 2 的 1 号色应当是绿');
  assert.equal(green.rgba[0], 0);
});

test('4bpp 低半字节是左边像素：0x21 的左边是 1、右边是 2', () => {
  const vram = makeVram();
  const palette = makePalette();
  // 调色板 2 号色（bank 0 index 2）= BGR555 0x7C00 蓝
  palette[4] = 0x00;
  palette[5] = 0x7c;
  const base = CHAR_BASE + 1 * 32;
  vram.fill(0x21, base, base + 32); // 低半字节 1（红）在左，高半字节 2（蓝）在右
  setEntry(vram, 0, 0, 0x0001); // bank 0, tileIndex 1
  const bgcnt = (1 << 8) | 0;
  const out = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  const at = (x) => [...out.rgba.subarray(x * 4, x * 4 + 3)];
  assert.deepEqual(at(0), [y4(31), y4(0), y4(0)], '左边像素是低半字节');
  assert.deepEqual(at(1), [y4(0), y4(0), y4(31)], '右边像素是高半字节');
});

test('水平翻转 bit10：颜色左右互换，位置不互换', () => {
  const vram = makeVram();
  const palette = makePalette();
  palette[4] = 0x00;
  palette[5] = 0x7c;
  const base = CHAR_BASE + 1 * 32;
  vram.fill(0x21, base, base + 32);
  const bgcnt = (1 << 8) | 0;
  setEntry(vram, 0, 0, 0x0001);
  const normal = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  setEntry(vram, 0, 0, 0x0401); // bit10 = 水平翻转
  const flipped = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  assert.equal(normal.rgba[0], y4(31));
  assert.equal(flipped.rgba[0], y4(0));
  assert.equal(flipped.rgba[4], y4(31), '翻转后左像素变成原来的右像素');
});

test('垂直翻转 bit11：第 0 行与第 7 行互换', () => {
  const vram = makeVram();
  const palette = makePalette();
  const base = CHAR_BASE + 1 * 32;
  // 只有最后一行写字（index 1），其余透明
  vram.fill(0x11, base + 7 * 4, base + 8 * 4);
  const bgcnt = (1 << 8) | 0;
  setEntry(vram, 0, 0, 0x0001);
  const normal = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  assert.equal(normal.rgba[3], 0, '正常时第 0 行透明');
  assert.equal(normal.rgba[(7 * 240) * 4 + 3], 255, '正常时第 7 行有内容');
  setEntry(vram, 0, 0, 0x0801); // bit11 = 垂直翻转
  const flipped = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  assert.equal(flipped.rgba[3], 255, '翻转后第 0 行有内容');
  assert.equal(flipped.rgba[(7 * 240) * 4 + 3], 0);
});

test('滚动：hofs=3 时屏幕第 0 列取的是地图第 3 列', () => {
  const vram = makeVram();
  const palette = makePalette();
  fillTile4bpp(vram, 1, 0x11);
  setEntry(vram, 1, 0, 0x0001); // 只有地图 (1,0) 有红块
  const bgcnt = (1 << 8) | 0;
  const noScroll = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  assert.equal(noScroll.rgba[3], 0, '不滚动时屏幕最左是空的');
  const scrolled = renderTextBg({vram, palette, bgcnt, hofs: 8, vofs: 0});
  assert.equal(scrolled.rgba[3], 255, '滚动 8 像素后，地图第 1 格贴到屏幕最左');
});

test('索引 0 是透明，摊平后变成背景色（调色板 0 号色），不是黑色', () => {
  const vram = makeVram();
  const palette = makePalette();
  palette[0] = 0xe0; // 背景 = 绿
  palette[1] = 0x03;
  const bgcnt = (1 << 8) | 0;
  const layer = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  assert.equal(layer.rgba[3], 0);
  assert.deepEqual(backdropColor(palette), [y4(0), y4(31), y4(0), 255]);
  const flat = flattenOnBackdrop(layer, palette);
  assert.deepEqual([...flat.rgba.subarray(0, 4)], [y4(0), y4(31), y4(0), 255]);
});

test('8bpp 模式：没有 bank 概念，索引直接是多色调色板的编号', () => {
  const vram = makeVram();
  const palette = makePalette();
  // 8bpp：一字节一像素，index 200
  palette[200 * 2] = 0x1f;
  palette[200 * 2 + 1] = 0x00;
  const base = CHAR_BASE + 1 * 64;
  vram.fill(200, base, base + 64);
  setEntry(vram, 0, 0, 0x0001); // 高 4 位在 8bpp 下被忽略
  const bgcnt = (1 << 8) | (1 << 7); // screenBase 0x800, 8bpp
  const out = renderTextBg({vram, palette, bgcnt, hofs: 0, vofs: 0});
  assert.deepEqual([...out.rgba.subarray(0, 3)], [y4(31), y4(0), y4(0)]);
});
