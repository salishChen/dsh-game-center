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
      rgba[dst + 0] = (r5 << 3) | (r5 >> 2);
      rgba[dst + 1] = (g5 << 3) | (g5 >> 2);
      rgba[dst + 2] = (b5 << 3) | (b5 >> 2);
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
  return [(r5 << 3) | (r5 >> 2), (g5 << 3) | (g5 >> 2), (b5 << 3) | (b5 >> 2), 0xff];
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
