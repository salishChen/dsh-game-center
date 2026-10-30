import {createHash} from 'node:crypto';

/**
 * 掩码打包（1 bit / 像素），**约定就是判据的一部分**。
 *
 * 约定（与逆向、PM 对齐，见 docs/frame-compare.md）：
 *   - 行优先（row-major），从上到下、从左到右
 *   - 每像素 1 bit，非 0 = 1
 *   - **MSB-first**：一行内第 0 个像素落在该字节的 bit7
 *   - 每行补 0 到整字节：`ceil(width / 8)` 字节/行（240 → 30 B/行）
 *   - 摘要 = sha256(打包后的字节)，十六进制小写，不带前缀
 *
 * 为什么 bit 序必须写死：同一个像素集合，MSB-first 与 LSB-first 会给出**两个不同的 sha**。
 * 本项目真实发生过：两侧集合经逐像素比较确认相等（`onlyMine 0 / onlyImpl 0`），
 * 但贴出来的 sha 对不上——不是数据错，是打包口径不同。sha 相等与否只在"约定相同"时
 * 才代表集合相等，所以约定必须随产物一起走（`mask_convention`），也必须有一份
 * **已知答案向量**来钉住两边的实现。
 */
export const MASK_CONVENTION = Object.freeze({
  width: 240,
  height: 160,
  row_major: true,
  msb_first: true,
  pad: 'zero-to-byte',
  bytes_per_row: 30,
});

/** 打包成字节。`pixels[i]` 非 0 视为 1。 */
export function packMask(pixels, {width = MASK_CONVENTION.width, height = MASK_CONVENTION.height} = {}) {
  // 形状核对：喂错了不会被发现，只会安静地算出另一组字节。
  // 本项目真踩过：把扁平数组喂给"收 rows 二维数组"的接口，对撞测试报"两套实现对不上"，
  // 而真相只是调用错。这类 bug 的特征是**不报错、只安静取错**。
  const expected = width * height;
  if (!pixels || typeof pixels.length !== 'number') {
    throw new TypeError('packMask 需要可索引的像素数组（扁平，长度 = width × height）');
  }
  if (pixels.length !== expected) {
    throw new RangeError(`packMask 像素数量不符：期望 ${expected}（${width}×${height}），实际 ${pixels.length}`);
  }
  const bytesPerRow = Math.ceil(width / 8);
  const packed = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[y * width + x]) packed[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return packed;
}

/** 打包后的集合摘要（判据用的就是这个值）。 */
export function packMaskSha256(pixels, size) {
  return createHash('sha256').update(packMask(pixels, size)).digest('hex');
}

/** 该集合的约定说明，随产物一起走；`bitSource` 说明"这里的 1 代表什么"。 */
export function maskConventionOf(bitSource, size = MASK_CONVENTION) {
  return {
    width: size.width,
    height: size.height,
    row_major: size.row_major,
    bit_source: bitSource,
    msb_first: size.msb_first,
    pad: size.pad,
    bytes_per_row: Math.ceil(size.width / 8),
  };
}
