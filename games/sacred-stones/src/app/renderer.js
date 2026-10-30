/**
 * 画面渲染：内核 framebuffer → canvas
 *
 * 内核的 `ppu.getFramebuffer()` 是 `Uint32Array`，每个元素 `0xAABBGGRR`（R 在最低字节）。
 * 小端机器上这块内存的字节序正好是 `[R, G, B, A]`，而 `ImageData` 要的就是 RGBA 顺序 ——
 * 所以可以整块直接写进去，一个像素都不用逐位转。这是有意的：多一次转换就多一处可能和原机不一致。
 */

export const SCREEN_WIDTH = 240;
export const SCREEN_HEIGHT = 160;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{width?: number, height?: number}} [options]
 */
export function createRenderer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('createRenderer 需要 canvas');
  const width = options.width ?? SCREEN_WIDTH;
  const height = options.height ?? SCREEN_HEIGHT;

  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {alpha: false, desynchronized: true});
  if (!context) throw new Error('拿不到 canvas 2d 上下文');

  const image = context.createImageData(width, height);
  const pixels = new Uint32Array(image.data.buffer);

  return {
    width,
    height,

    /** @param {Uint32Array} framebuffer 长度必须是 width*height */
    draw(framebuffer) {
      if (!framebuffer || framebuffer.length < width * height) return false;
      pixels.set(framebuffer.subarray(0, width * height));
      context.putImageData(image, 0, 0);
      return true;
    },

    clear() {
      pixels.fill(0xff000000);
      context.putImageData(image, 0, 0);
    },
  };
}
