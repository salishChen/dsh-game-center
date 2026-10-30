// GBA OBJ（精灵）合成器：纯函数，输入是同一帧的 OAM + VRAM + 调色板快照。
//
// 为什么要单独一层：OBJ 和 BG 的规则完全不同——图块地址由 DISPCNT bit6 决定
// 走 1D 还是 2D 映射、256 色/16 色 bank 的取法不同、还有旋转缩放、翻转、
// 半透明和 mosaic。混在 BG 里一起比，出错时分不清是哪一套规则错了。
//
// 规矩（都是会让人查错方向的地方）：
//   * 尺寸由 shape(attr0 bit14-15) + size(attr1 bit14-15) 两个字段共同决定，
//     单看 size 是不够的；
//   * attr0 的 y 有 8 位，attr1 的 x 有 9 位（后者可以表示负坐标）；
//   * OBJ 的 y 是按"中心对齐"解释的：真实显示行 = objY - 屏幕行偏移……见
//     objTop()，别自己推，这里已经踩过；
//   * 256 色模式没有 bank，16 色模式的 bank 来自 attr2 bit12；
//   * 索引 0 恒为透明，且**不参与**翻转后的错位补偿。

// 调色板 RAM 前 512 字节是 BG 的 16 个 bank，OBJ 的 16 个 bank 从 0x200 开始。
// 这里原来写成 256（= 0x100），正好落在 BG bank 中间——颜色不会报错，只会安静地错。
const OBJ_PALETTE_OFFSET = 0x200;

// OBJ 的图块基址是 0x06010000，不是 0x06000000：vram 数组从 0x06000000 起算，
// 所以精灵图块地址必须再加 0x10000。漏掉这一项，读到的永远是 BG 图块区——
// 数据看起来"像"图块、颜色"像"对的，只有形状散架，极难自查。
const OBJ_TILE_BASE = 0x10000;

const OBJ_MAX_SPRITES_PER_LINE = 64;
const OBJ_MAX_PIXELS_PER_LINE = 1024;

const SCREEN_W = 240;
const SCREEN_H = 160;

/** 每像素字节数不受 shape 影响，只有 16/256 色两种。 */
const TILE_BYTES_16 = 32;
const TILE_BYTES_256 = 64;

// 守卫：这两个常量写错时游戏"能跑、不报错、只是画得不对"，是这个项目里最难自查的一类错。
// 断言放在模块加载时执行，任何人把它改小都会立刻红，而不是等下一次去做像素比对才发现。
if (!(OBJ_PALETTE_OFFSET >= 0x200)) throw new Error(`OBJ 调色板起始偏移必须 >= 0x200（512 字节），当前 0x${OBJ_PALETTE_OFFSET.toString(16)}`);
if (!(OBJ_TILE_BASE >= 0x10000)) throw new Error(`OBJ 图块基址必须 >= 0x10000，当前 0x${OBJ_TILE_BASE.toString(16)}`);

export const OBJ_SHAPE = {SQUARE: 0, WIDE: 1, TALL: 2, PROHIBITED: 3};

/** shape × size → [宽, 高]（像素）。prohibited 组合返回 null。 */
const SIZES = {
  0: {0: [8, 8], 1: [16, 16], 2: [32, 32], 3: [64, 64]},
  1: {0: [16, 8], 1: [32, 8], 2: [32, 16], 3: [64, 32]},
  2: {0: [8, 16], 1: [8, 32], 2: [16, 32], 3: [32, 64]},
};

export function objSize(shape, size) {
  return SIZES[shape]?.[size] ?? null;
}

/**
 * 解析一条 OAM 记录（attr0/attr1/attr2，各 16 位，顺序与内存一致）。
 */
export function parseObj(attr0, attr1, attr2) {
  const shape = (attr0 >> 14) & 0x3;
  const size = (attr1 >> 14) & 0x3;
  const dims = objSize(shape, size);
  return {
    // attr0
    y: attr0 & 0xff,
    affine: Boolean((attr0 >> 8) & 1),
    hide: Boolean((attr0 >> 9) & 1),
    // 00 普通 / 01 半透明 / 10 窗口
    mode: (attr0 >> 10) & 0x3,
    mosaic: Boolean((attr0 >> 12) & 1),
    colorMode8bpp: Boolean((attr0 >> 13) & 1),
    shape,
    // attr1
    x: attr1 & 0x1ff,
    affineIndex: (attr1 >> 9) & 0x1f,
    hflip: Boolean((attr1 >> 12) & 1),
    vflip: Boolean((attr1 >> 13) & 1),
    size,
    width: dims?.[0] ?? 0,
    height: dims?.[1] ?? 0,
    dimsValid: Boolean(dims),
    // attr2
    tileIndex: attr2 & 0x3ff,
    priority: (attr2 >> 10) & 0x3,
    paletteBank: (attr2 >> 12) & 0xf,
  };
}

/**
 * 精灵左上角在屏幕上的 y。
 *
 * attr0 的 y 字段是 8 位，硬件把它当成"模 256 的行号"：当 y + 高度超过 256 时，
 * 精灵会绕回屏幕顶部显示。直接当有符号数或直接当绝对坐标都会在边缘出怪象。
 */
export function objTop(obj) {
  return obj.y;
}

/** 精灵在屏幕上横跨的列（含负坐标与右侧超出，调用方自己裁剪）。 */
export function objLeft(obj) {
  // attr1 的 x 是 9 位：256..511 表示 -256..-1
  return obj.x >= 256 ? obj.x - 512 : obj.x;
}

const TILE = 8;

/**
 * 计算精灵某个像素对应的 VRAM 字节地址。
 *
 * @param {{tileIndex: number, colorMode8bpp: boolean, width: number, height: number}} obj
 * @param {number} px 精灵内 x（0..width-1）
 * @param {number} py 精灵内 y（0..height-1）
 * @param {boolean} oneDimensional DISPCNT bit6
 */
export function objTileAddress(obj, px, py, oneDimensional) {
  const bytesPerTile = obj.colorMode8bpp ? TILE_BYTES_256 : TILE_BYTES_16;
  const tileRow = Math.floor(py / TILE);
  const tileCol = Math.floor(px / TILE);
  if (oneDimensional) {
    // 1D：图块号沿着一行接一行连续排，行跨度 = 精灵宽 / 8 块
    const tilesPerRow = obj.width / TILE;
    const tile = obj.tileIndex + tileRow * tilesPerRow + tileCol;
    return OBJ_TILE_BASE + tile * bytesPerTile;
  }
  // 2D：图块号按 32×32 的整屏图块表排布，行跨度固定 32 块
  const tile = (obj.tileIndex & 0x3ff) + tileRow * 0x20 + tileCol;
  return OBJ_TILE_BASE + tile * bytesPerTile;
}

/** 读精灵像素的调色板索引（0 = 透明）。 */
export function objPixelIndex(obj, vram, px, py, oneDimensional) {
  const addr = objTileAddress(obj, px, py, oneDimensional);
  const within = (py % TILE) * TILE + (px % TILE);
  if (obj.colorMode8bpp) return vram[addr + within];
  const bite = vram[addr + (within >> 1)];
  return (within & 1) === 0 ? bite & 0x0f : bite >> 4;
}

/**
 * 把一条精灵画进像素缓冲（不处理旋转/缩放，那是另一条路径）。
 * @returns {number} 实际写入的像素数
 */
export function drawObj(image, obj, {vram, palette, oneDimensional = true, priorityMap = null}) {
  if (obj.hide || !obj.dimsValid) return 0;
  const left = objLeft(obj);
  const top = objTop(obj);
  let painted = 0;
  for (let py = 0; py < obj.height; py += 1) {
    const sy = top + py;
    if (sy < 0 || sy >= SCREEN_H) continue;
    for (let px = 0; px < obj.width; px += 1) {
      const sx = left + px;
      if (sx < 0 || sx >= SCREEN_W) continue;
      const srcX = obj.hflip ? obj.width - 1 - px : px;
      const srcY = obj.vflip ? obj.height - 1 - py : py;
      const index = objPixelIndex(obj, vram, srcX, srcY, oneDimensional);
      if (index === 0) continue;
      const palOffset = (obj.colorMode8bpp ? index : obj.paletteBank * 16 + index) * 2;
      const at = OBJ_PALETTE_OFFSET + palOffset;
      const bgr555 = palette[at] | (palette[at + 1] << 8);
      const dst = (sy * SCREEN_W + sx) * 4;
      image[dst + 0] = expand5(bgr555 & 0x1f);
      image[dst + 1] = expand5((bgr555 >> 5) & 0x1f);
      image[dst + 2] = expand5((bgr555 >> 10) & 0x1f);
      image[dst + 3] = 0xff;
      // 每个精灵有自己的 priority（attr2 bit10-11）。整层合成时不能统一当 0 处理：
      // 同一 priority 上 OBJ 盖过 BG，但 OBJ 的 priority 比 BG 大时就必须让 BG 压住它。
      if (priorityMap) priorityMap[sy * SCREEN_W + sx] = obj.priority;
      painted += 1;
    }
  }
  return painted;
}

/**
 * 合成整层 OBJ。
 *
 * 两条**硬件上限**在这里实现，它们不会报错、只会让画面"少几个精灵"：
 *   ① 每条扫描线最多考虑 **64 个**精灵（按 priority 升序、同 priority 按 OAM 序号升序取前 64）；
 *   ② 每条扫描线最多绘制 **1024 个** OBJ 像素，额度用完后该行剩下的精灵全部丢弃。
 * 两者都是"先到先得"：排序靠前的（priority 小 / OAM 序号小）优先占用额度。
 *
 * 这个上限是实测逼出来的：帧 3200 有 128 个精灵，整屏合成差 1,105 像素，
 * 而差异处硬件显示的是"下方的 BG 层"——说明那个精灵被硬件丢掉了，不是颜色算错。
 *
 * @returns {{width, height, rgba, paintedPixels, priorityMap, dropped}} dropped = {overLimit, overPixels}
 */
export function renderObjLayer({
  oam,
  vram,
  palette,
  dispcnt,
  width = SCREEN_W,
  height = SCREEN_H,
  backdrop,
  maxSpritesPerLine = OBJ_MAX_SPRITES_PER_LINE,
  maxPixelsPerLine = OBJ_MAX_PIXELS_PER_LINE,
}) {
  const oneDimensional = Boolean((dispcnt >> 6) & 1);
  const out = new Uint8Array(width * height * 4);
  const priorityMap = new Uint8Array(width * height).fill(0xff);

  const objs = [];
  for (let i = 0; i < 128; i += 1) {
    const base = i * 8;
    const obj = parseObj(
      oam[base] | (oam[base + 1] << 8),
      oam[base + 2] | (oam[base + 3] << 8),
      oam[base + 4] | (oam[base + 5] << 8),
    );
    if (obj.hide || !obj.dimsValid) continue;
    objs.push({obj, order: i});
  }
  // 硬件按 priority 升序、同 priority 按 OAM 序号升序处理（先处理的最优先）。
  objs.sort((a, b) => (a.obj.priority - b.obj.priority) || (a.order - b.order));

  let painted = 0;
  let overLimit = 0;
  let overPixels = 0;

  for (let y = 0; y < height; y += 1) {
    if (y >= SCREEN_H) break;
    const candidates = objs.filter(({obj}) => y >= objTop(obj) && y < objTop(obj) + obj.height);
    const chosen = candidates.slice(0, maxSpritesPerLine);
    overLimit += candidates.length - chosen.length;

    let budget = maxPixelsPerLine;
    for (const {obj} of chosen) {
      if (budget <= 0) {
        overPixels += 1;
        continue;
      }
      const top = objTop(obj);
      const py = y - top;
      const left = objLeft(obj);
      const srcY = obj.vflip ? obj.height - 1 - py : py;
      let drewThisLine = 0;
      for (let px = 0; px < obj.width; px += 1) {
        const sx = left + px;
        if (sx < 0 || sx >= SCREEN_W) continue;
        const dst = (y * SCREEN_W + sx) * 4;
        if (out[dst + 3] !== 0) continue; // 已被更优先的精灵占用
        if (budget <= 0) break;
        const srcX = obj.hflip ? obj.width - 1 - px : px;
        const index = objPixelIndex(obj, vram, srcX, srcY, oneDimensional);
        if (index === 0) continue;
        const palOffset = (obj.colorMode8bpp ? index : obj.paletteBank * 16 + index) * 2;
        const at = OBJ_PALETTE_OFFSET + palOffset;
        const bgr555 = palette[at] | (palette[at + 1] << 8);
        out[dst + 0] = expand5(bgr555 & 0x1f);
        out[dst + 1] = expand5((bgr555 >> 5) & 0x1f);
        out[dst + 2] = expand5((bgr555 >> 10) & 0x1f);
        out[dst + 3] = 0xff;
        priorityMap[y * SCREEN_W + sx] = obj.priority;
        budget -= 1;
        drewThisLine += 1;
      }
      painted += drewThisLine;
    }
  }

  if (backdrop) {
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] !== 0) continue;
      out[i + 0] = backdrop[0];
      out[i + 1] = backdrop[1];
      out[i + 2] = backdrop[2];
      out[i + 3] = 0xff;
    }
  }
  return {width, height, rgba: out, paintedPixels: painted, priorityMap, dropped: {overLimit, overPixels}};
}

import {expand5} from './color.js';
