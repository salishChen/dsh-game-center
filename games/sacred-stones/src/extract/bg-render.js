// GBA 文本层（BG mode 0）合成器：纯函数，输入全是内存快照，输出 RGBA。
//
// 为什么要有它：素材必须由「图块 + 调色板 + 图块地图」三样按硬件规则拼出来，
// 才谈得上"复原"。有了它，就能拿模拟器自己渲染的同一帧当参照逐像素比对，
// 从而在不依赖任何人肉眼的情况下证明"我拼的和硬件拼的一样"。
//
// 规矩（吃过亏的地方）：
//   * 每个参数都从**同一帧**的寄存器快照里取，函数里不许出现写死的基址；
//   * 4bpp 的**低半字节是左边像素**，写反会碎成斜纹；
//   * 索引 0 是透明，透出背景色（调色板 0 号色），不是画成黑色；
//   * 图块地图条目：低 10 位图块号、bit10 水平翻转、bit11 垂直翻转、高 4 位调色板 bank。

import {expand5, to5, write5To, blend5, blend8, parseBldcnt} from './color.js';

const TILE = 8;
const BYTES_PER_4BPP_TILE = 32;
const BYTES_PER_8BPP_TILE = 64;

// BGxCNT 位域
export function parseBgcnt(value) {
  return {
    priority: value & 0x3,
    charBase: ((value >> 2) & 0x3) * 0x4000,
    mosaic: (value >> 6) & 0x1,
    colorMode8bpp: (value >> 7) & 0x1,
    screenBase: ((value >> 8) & 0x1f) * 0x800,
    affineWrap: (value >> 13) & 0x1,
    size: (value >> 14) & 0x3,
  };
}

// size 决定地图的图块行列数与屏幕像素尺寸（文本模式）
export function mapDimensions(size) {
  switch (size) {
    case 0: return {cols: 32, rows: 32};
    case 1: return {cols: 64, rows: 32};
    case 2: return {cols: 32, rows: 64};
    case 3: return {cols: 64, rows: 64};
    default: throw new Error(`未知的 BG 尺寸 ${size}`);
  }
}

// 地图在 256x256 的"块"里分屏排布；size 1/2/3 时第二块紧接在第一块之后，
// 不是简单地把行列数翻倍——这正是 size 1 的 64x32 与普通 64 列的差别。
function mapEntryAddress(screenBase, cols, tileX, tileY) {
  const blocksPerRow = cols / 32;
  const blockX = Math.floor(tileX / 32);
  const blockY = Math.floor(tileY / 32);
  const localX = tileX % 32;
  const localY = tileY % 32;
  const blockIndex = blockY * blocksPerRow + blockX;
  return screenBase + blockIndex * 0x800 + (localY * 32 + localX) * 2;
}

function readPixelIndex(viewport, offset, colorMode8bpp) {
  if (colorMode8bpp) return viewport[offset];
  const byte = viewport[offset >> 1];
  // 低半字节是左边像素
  return (offset & 1) === 0 ? byte & 0x0f : byte >> 4;
}

/**
 * 合成一层文本 BG。
 * @param {{vram: Uint8Array, palette: Uint8Array, bgcnt: number, hofs: number, vofs: number,
 *          width?: number, height?: number}} input
 * @returns {{width: number, height: number, rgba: Uint8Array, transparentPixels: number}}
 */
export function renderTextBg({vram, palette, bgcnt, hofs, vofs, width = 240, height = 160}) {
  const cfg = parseBgcnt(bgcnt);
  const {cols, rows} = mapDimensions(cfg.size);
  const tileBytes = cfg.colorMode8bpp ? BYTES_PER_8BPP_TILE : BYTES_PER_4BPP_TILE;
  const rgba = new Uint8Array(width * height * 4);
  let transparentPixels = 0;

  for (let y = 0; y < height; y += 1) {
    const mapY = (y + vofs) & 0xff;
    const tileY = mapY >> 3;
    const py = mapY & 7;
    for (let x = 0; x < width; x += 1) {
      const mapX = (x + hofs) & 0xff;
      const tileX = mapX >> 3;
      const px = mapX & 7;

      if (tileX >= cols || tileY >= rows) {
        transparentPixels += 1;
        continue;
      }

      const entryAddr = mapEntryAddress(cfg.screenBase, cols, tileX, tileY);
      const entry = vram[entryAddr] | (vram[entryAddr + 1] << 8);
      const tileIndex = entry & 0x3ff;
      const hflip = (entry >> 10) & 1;
      const vflip = (entry >> 11) & 1;
      const bank = (entry >> 12) & 0xf;

      const srcX = hflip ? 7 - px : px;
      const srcY = vflip ? 7 - py : py;
      const tileAddr = cfg.charBase + tileIndex * tileBytes;
      const pixelOffset = srcY * TILE + srcX;
      // 4bpp：一个字节两个像素，低半字节在左；8bpp：一字节一像素。
      // 这里只算一次地址——之前把"字节地址"和"像素序号"各除了一次 2，
      // 结果整层都是透明，看起来像"图块不在 VRAM 里"，其实是自己算错。
      const index = cfg.colorMode8bpp
        ? vram[tileAddr + pixelOffset]
        : ((pixelOffset & 1) === 0
          ? vram[tileAddr + (pixelOffset >> 1)] & 0x0f
          : vram[tileAddr + (pixelOffset >> 1)] >> 4);

      const dst = (y * width + x) * 4;
      if (index === 0) {
        transparentPixels += 1;
        continue;
      }
      // 4bpp 的 bank 来自地图条目；8bpp 没有 bank（整层一个 256 色调色板）
      const palIndex = (cfg.colorMode8bpp ? index : bank * 16 + index) * 2;
      const bgr555 = palette[palIndex] | (palette[palIndex + 1] << 8);
      const r5 = bgr555 & 0x1f;
      const g5 = (bgr555 >> 5) & 0x1f;
      const b5 = (bgr555 >> 10) & 0x1f;
      rgba[dst + 0] = expand5(r5);
      rgba[dst + 1] = expand5(g5);
      rgba[dst + 2] = expand5(b5);
      rgba[dst + 3] = 0xff;
    }
  }

  return {width, height, rgba, transparentPixels};
}

/** 背景色（调色板 0 号色），透明像素最终显示的就是它。 */
export function backdropColor(palette) {
  const bgr555 = palette[0] | (palette[1] << 8);
  const r5 = bgr555 & 0x1f;
  const g5 = (bgr555 >> 5) & 0x1f;
  const b5 = (bgr555 >> 10) & 0x1f;
  return [expand5(r5), expand5(g5), expand5(b5), 0xff];
}

/** 把透明像素填成背景色，得到可以直接和 framebuffer 比的图。 */
export function flattenOnBackdrop(layer, palette, backdrop = backdropColor(palette)) {
  const out = Uint8Array.from(layer.rgba);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) {
      out[i + 0] = backdrop[0];
      out[i + 1] = backdrop[1];
      out[i + 2] = backdrop[2];
      out[i + 3] = 0xff;
    }
  }
  return {width: layer.width, height: layer.height, rgba: out};
}

/**
 * 多图层叠加：同一点上取 priority 数值最小的层；priority 相同时 BG 序号小的在上。
 * 全透明处显示背景色。
 * @param {{vram: Uint8Array, palette: Uint8Array, layers: Array<{bgcnt: number, hofs: number, vofs: number}>,
 *          width?: number, height?: number}} input
 */
export function renderBgStack({vram, palette, layers, width = 240, height = 160}) {
  const rendered = layers.map((layer) => ({
    ...layer,
    cfg: parseBgcnt(layer.bgcnt),
    image: renderTextBg({vram, palette, bgcnt: layer.bgcnt, hofs: layer.hofs, vofs: layer.vofs, width, height}),
  }));

  // 排序：priority 小的先画在上层；同一 priority 按数组顺序（调用方按 BG 序号给）
  const order = rendered
    .map((layer, index) => ({layer, index}))
    .sort((a, b) => (a.layer.cfg.priority - b.layer.cfg.priority) || (a.index - b.index));

  const out = new Uint8Array(width * height * 4);
  const backdrop = backdropColor(palette);
  for (let i = 0; i < width * height; i += 1) {
    const dst = i * 4;
    let painted = false;
    for (const {layer} of order) {
      if (layer.image.rgba[dst + 3] === 0) continue;
      out[dst + 0] = layer.image.rgba[dst + 0];
      out[dst + 1] = layer.image.rgba[dst + 1];
      out[dst + 2] = layer.image.rgba[dst + 2];
      out[dst + 3] = 0xff;
      painted = true;
      break;
    }
    if (!painted) {
      out[dst + 0] = backdrop[0];
      out[dst + 1] = backdrop[1];
      out[dst + 2] = backdrop[2];
      out[dst + 3] = 0xff;
    }
  }
  return {width, height, rgba: out};
}

/**
 * 带颜色特效的叠加：在 **5 位域** 里算，最后只展开一次。
 *
 * 为什么必须回 5 位：硬件的混合是 `(a*b + c*(16-b)) >> 4` 这样的整数运算，
 * 在 8 位展开值上做同样的运算会得到不同结果（低 3 位是重复信息，参与运算就污染了）。
 */
export function renderBgStackBlended({
  vram,
  palette,
  layers,
  bldcnt = 0,
  bldalpha = 0,
  bldy = 0,
  width = 240,
  height = 160,
  // '5bit' = 真机口径（GBATEK：在 15 位域算）；'8bit' = @gba-kit 参照实现的口径。
  // 发货用 5bit；跑 oracle 时用 8bit 才能和这个模拟器逐像素对上。
  blendDomain = '5bit',
}) {
  const rendered = layers.map((layer, index) => ({
    // 层的真实 BG 序号必须由调用方给：BLDCNT 的位是按 BG 序号编的，
    // 用数组下标代替会让"这层是不是特效目标"判断到隔壁层上去。
    index: layer.bgIndex ?? index,
    cfg: parseBgcnt(layer.bgcnt),
    image: renderTextBg({
      vram,
      palette,
      bgcnt: layer.bgcnt,
      hofs: layer.hofs,
      vofs: layer.vofs,
      width,
      height,
    }),
  }));
  const order = rendered.sort(
    (a, b) => a.cfg.priority - b.cfg.priority || a.index - b.index,
  );

  const fx = parseBldcnt(bldcnt);
  const eva = bldalpha & 0x1f;
  const evb = (bldalpha >> 8) & 0x1f;
  const backdrop = backdropColor(palette);
  const backdrop5 = [to5(backdrop[0]), to5(backdrop[1]), to5(backdrop[2])];

  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * 4;
    let top = null;
    let topBg = -1;
    for (const {index, image} of order) {
      if (image.rgba[src + 3] === 0) continue;
      top = [to5(image.rgba[src]), to5(image.rgba[src + 1]), to5(image.rgba[src + 2])];
      topBg = index;
      break;
    }

    let rgb5;
    if (blendDomain === '8bit') {
      // @gba-kit 的 5→8 展开是 `v << 3`（不复制高位），不是 (v<<3)|(v>>2)。
      // 这一行必须跟着它走，否则亮度模式会差 1 个 5 位级——那 5,785 个红像素
      // 不是我的公式错，是两套展开口径的差。
      const top8 = top === null ? null : [top[0] << 3, top[1] << 3, top[2] << 3];
      const back8 = [backdrop5[0] << 3, backdrop5[1] << 3, backdrop5[2] << 3];
      const src8 = top8 ?? back8;
      const shouldBlend = top === null
        ? fx.targetBackdrop && fx.mode !== 0
        : fx.targetsBg.includes(topBg) && fx.mode !== 0
          && (fx.mode === 1 ? fx.secondTargetBackdrop : true);
      const out8 = shouldBlend ? blend8(src8, back8, {mode: fx.mode, eva, evb, evy: bldy}) : src8;
      write5To(out, src, [out8[0] >> 3, out8[1] >> 3, out8[2] >> 3], 0xff);
      continue;
    }
    if (top === null) {
      // 这一格是背景色。只有把 BD 列为第一目标时，特效才作用在它上面。
      rgb5 = fx.targetBackdrop && fx.mode !== 0
        ? blend5(backdrop5, backdrop5, {mode: fx.mode, eva, evb, evy: bldy})
        : backdrop5;
    } else if (fx.targetsBg.includes(topBg) && fx.mode !== 0 && fx.secondTargetBackdrop) {
      // 第一目标命中、且第二目标里有 BD 才混：只有第一目标时硬件什么都不做。
      rgb5 = blend5(top, backdrop5, {mode: fx.mode, eva, evb, evy: bldy});
    } else {
      rgb5 = top;
    }
    write5To(out, src, rgb5, 0xff);
  }
  return {width, height, rgba: out};
}
