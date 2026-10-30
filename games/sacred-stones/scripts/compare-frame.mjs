#!/usr/bin/env node
// 帧比较器：把「某张实际渲染图」与「某张期望图」按契约比出可判定的数字。
//
// 用法：
//   node scripts/compare-frame.mjs --actual a.png --expected b.png \
//        [--native 240x160] [--tolerance 1] [--region x,y,w,h] [--json out.json]
//
// 契约（项目经理定，见 docs/frame-compare.md）：
//   1. 一律先缩到原生 240x160；放大图用**最近邻**整数倍还原，绝不用双线性
//      （双线性会把每个像素都改一点，diff 直接满分失败，且失败的形状像"合成器全错"）。
//   2. 逐通道容差默认 1：BGR555→RGBA8 的两种换算（(v<<3)|(v>>2) 与 v*255/31）
//      天生相差 1。严格相等只适用于"两张图出自同一段转换代码"。
//   3. 输出三个数：差异像素数 / 参与比较的像素总数 / 占比，外加最大单通道偏差。
//      只报"看起来差一点"等于没有判据。
//   4. --region 只比一块矩形，用来分层定位：单块 → 一块区域 → 整屏。
//      跳级比较会让第一次红的时候不知道红在哪一层。

import {readFileSync, writeFileSync} from 'node:fs';
import {decodePng} from '../src/extract/png.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      out[name] = true;
    } else {
      out[name] = value;
      i += 1;
    }
  }
  return out;
}

// 最近邻缩放到原生尺寸。只接受整数倍放大（3x/4x 是模拟器常见档位）；
// 非整数倍直接拒绝，因为"用最近邻缩非整数倍"得到的图不是任何真实渲染，
// 拿来比会把结论变成噪声。
export function toNative({width, height, rgba}, nativeWidth = 240, nativeHeight = 160) {
  if (width === nativeWidth && height === nativeHeight) return {width, height, rgba, scale: 1};
  if (width % nativeWidth !== 0 || height % nativeHeight !== 0) {
    throw new Error(
      `尺寸 ${width}x${height} 不是 ${nativeWidth}x${nativeHeight} 的整数倍；` +
        '请提供原生尺寸或整数倍放大的截图（非整数倍缩回不可比较）',
    );
  }
  const sx = width / nativeWidth;
  const sy = height / nativeHeight;
  if (sx !== sy) throw new Error(`横纵缩放比不一致（${sx} vs ${sy}），图被拉伸过`);
  const out = Buffer.alloc(nativeWidth * nativeHeight * 4);
  for (let y = 0; y < nativeHeight; y += 1) {
    for (let x = 0; x < nativeWidth; x += 1) {
      const src = ((y * sx) * width + x * sx) * 4;
      const dst = (y * nativeWidth + x) * 4;
      out[dst + 0] = rgba[src + 0];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return {width: nativeWidth, height: nativeHeight, rgba: out, scale: sx};
}

export function compareFrames(actual, expected, {tolerance = 1, region, quantizeBits = 0} = {}) {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(`尺寸不一致：${actual.width}x${actual.height} vs ${expected.width}x${expected.height}`);
  }
  // 跨实现比较颜色时，5 位→8 位的展开规则不同会把每个像素都改一点：
  // (v<<3)|(v>>2) 与 v<<3 在 v=31 时相差 7。与其把容差放大到 7（那会连真实
  // 错误一起掩盖），不如两边都回到 5 位域比较——量化后同一颜色的差异是 0。
  const mask = quantizeBits > 0 ? (0xff << quantizeBits) & 0xff : 0xff;
  const area = region ?? {x: 0, y: 0, width: actual.width, height: actual.height};
  if (
    area.x < 0 || area.y < 0 ||
    area.x + area.width > actual.width || area.y + area.height > actual.height ||
    area.width <= 0 || area.height <= 0
  ) {
    throw new Error(`区域 ${JSON.stringify(region)} 超出 ${actual.width}x${actual.height} 或为空`);
  }

  let diffPixels = 0;
  let maxChannelDelta = 0;
  let firstDiff = null;
  for (let y = area.y; y < area.y + area.height; y += 1) {
    for (let x = area.x; x < area.x + area.width; x += 1) {
      const i = (y * actual.width + x) * 4;
      let pixelDelta = 0;
      for (let c = 0; c < 4; c += 1) {
        const d = Math.abs((actual.rgba[i + c] & mask) - (expected.rgba[i + c] & mask));
        if (d > pixelDelta) pixelDelta = d;
      }
      if (pixelDelta > maxChannelDelta) maxChannelDelta = pixelDelta;
      if (pixelDelta > tolerance) {
        diffPixels += 1;
        if (!firstDiff) firstDiff = {x, y, actual: [...actual.rgba.subarray(i, i + 4)], expected: [...expected.rgba.subarray(i, i + 4)]};
      }
    }
  }

  const total = area.width * area.height;
  return {
    diffPixels,
    total,
    ratio: total === 0 ? 0 : diffPixels / total,
    maxChannelDelta,
    tolerance,
    region: area,
    firstDiff,
  };
}

function parseRegion(text) {
  if (!text || text === true) return undefined;
  const parts = String(text).split(',').map((v) => Number(v.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`--region 需要 x,y,w,h 四个整数（收到 "${text}"）`);
  }
  const [x, y, width, height] = parts;
  return {x, y, width, height};
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.actual || !args.expected) {
    console.error('用法：node scripts/compare-frame.mjs --actual a.png --expected b.png [--native 240x160] [--tolerance 1] [--region x,y,w,h] [--json out.json]');
    process.exit(2);
  }
  const [nw, nh] = String(args.native ?? '240x160').split('x').map(Number);
  const tolerance = args.tolerance === undefined ? 1 : Number(args.tolerance);

  const actual = toNative(decodePng(readFileSync(args.actual)), nw, nh);
  const expected = toNative(decodePng(readFileSync(args.expected)), nw, nh);
  const result = compareFrames(actual, expected, {tolerance, region: parseRegion(args.region)});

  const report = {...result, actual: String(args.actual), expected: String(args.expected)};
  const text =
    `差异像素 ${report.diffPixels} / ${report.total} = ${(report.ratio * 100).toFixed(3)}%\n` +
    `最大单通道偏差 ${report.maxChannelDelta}（容差 ${report.tolerance}）\n` +
    `区域 ${JSON.stringify(report.region)}\n` +
    (report.firstDiff ? `首个差异点 ${JSON.stringify(report.firstDiff)}\n` : '');
  process.stdout.write(text);
  if (args.json && args.json !== true) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.diffPixels === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('compare-frame.mjs')) {
  main();
}
