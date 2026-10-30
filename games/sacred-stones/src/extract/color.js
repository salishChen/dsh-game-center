/**
 * 颜色展开的唯一口径（发货口径）。
 *
 * 硬件算的是 15 位 BGR555；把 5 位扩展成 8 位有两种常见写法：
 *   1. v << 3            —— 最大值 31 → 248，纯白永远到不了 255
 *   2. (v << 3) | (v >> 2) —— 31 → 255，把这 5 位当成 8 位的高 5 位用
 *
 * 本项目发货用第 2 种，理由只有一条：屏幕上真正的白是 255，用第 1 种
 * 会让所有纯色都偏暗 7/255，且越亮偏得越明显（这正是当年 GBA 模拟器
 * "颜色发灰"的经典原因）。
 *
 * 注意：这是**产品口径**，不是比对口径。oracle 比对一律回到 5 位域
 * （见 quantizeTo5），因为那是硬件真正计算的空间。
 */

/** 5 位 → 8 位（发货口径）。 */
export function expand5(value) {
  const v = value & 0x1f;
  return (v << 3) | (v >> 2);
}

/** 8 位 → 5 位。expand5 的精确逆运算（丢掉的 3 位本来就是重复信息）。 */
export function to5(value8) {
  return (value8 & 0xff) >> 3;
}

/** RGBA(8 位) → [r,g,b] 的 5 位域。 */
export function rgbaTo5(rgba, offset) {
  return [to5(rgba[offset]), to5(rgba[offset + 1]), to5(rgba[offset + 2])];
}

/** 5 位域三元组 → RGBA 四个字节写进 out。 */
export function write5To(out, offset, rgb5, alpha = 0xff) {
  out[offset] = expand5(rgb5[0]);
  out[offset + 1] = expand5(rgb5[1]);
  out[offset + 2] = expand5(rgb5[2]);
  out[offset + 3] = alpha;
}

/** GBA 颜色特效模式（BLDCNT bit 6-7）。 */
export const BLEND_MODE = {NONE: 0, ALPHA: 1, BRIGHTEN: 2, DARKEN: 3};

/**
 * 在 5 位域做一次混合。这是硬件真正做的整数运算，没有浮点、没有 gamma。
 *
 * - ALPHA：`(top * eva + back * evb) >> 4`，eva/evb 0..16
 * - BRIGHTEN：`top + ((31 - top) * evy >> 4)`，evy 0..16
 * - DARKEN：`top - ((top * evy) >> 4)`
 *
 * **边界值 16 是重点**：GBA 里 16 表示"全部"，不是 1.0 的定点数写法问题，
 * 而是 `>> 4` 除以 16 的整数除法在 16 时刚好等于原值。写成 `>> 5` 或
 * 把 16 当非法值截到 15，都会差一路。
 */
export function blend5(top5, back5, {mode = BLEND_MODE.NONE, eva = 16, evb = 0, evy = 16} = {}) {
  if (mode === BLEND_MODE.ALPHA) {
    const a = Math.min(16, eva);
    const b = Math.min(16, evb);
    return [
      Math.min(31, (top5[0] * a + back5[0] * b) >> 4),
      Math.min(31, (top5[1] * a + back5[1] * b) >> 4),
      Math.min(31, (top5[2] * a + back5[2] * b) >> 4),
    ];
  }
  if (mode === BLEND_MODE.BRIGHTEN) {
    const y = Math.min(16, evy);
    return [
      Math.min(31, top5[0] + (((31 - top5[0]) * y) >> 4)),
      Math.min(31, top5[1] + (((31 - top5[1]) * y) >> 4)),
      Math.min(31, top5[2] + (((31 - top5[2]) * y) >> 4)),
    ];
  }
  if (mode === BLEND_MODE.DARKEN) {
    const y = Math.min(16, evy);
    return [
      Math.max(0, top5[0] - ((top5[0] * y) >> 4)),
      Math.max(0, top5[1] - ((top5[1] * y) >> 4)),
      Math.max(0, top5[2] - ((top5[2] * y) >> 4)),
    ];
  }
  return [top5[0], top5[1], top5[2]];
}

/**
 * 解析 BLDCNT。位域（真实硬件，别猜）：
 *   bit 0..3  = 第一目标 BG0..BG3
 *   bit 4     = 第一目标 OBJ
 *   bit 5     = 第一目标 BD（背景）
 *   bit 6..7  = 特效（1 alpha / 2 变亮 / 3 变暗）
 *   bit 8..11 = 第二目标 BG0..BG3
 *   bit 12    = 第二目标 OBJ
 *   bit 13    = 第二目标 BD
 *
 * 曾把"第二目标 BD"写成 bit5 —— 那是**第一目标 BD**。后果是硬件根本不混合
 * （只有第一目标、没有第二目标时不做任何混合），而我却算出"变暗一半"，
 * 于是 6,241 个像素全红，看起来像我的混合公式错了。
 */
export function parseBldcnt(value) {
  return {
    targetsBg: [0, 1, 2, 3].filter((n) => (value >> n) & 1),
    targetObj: Boolean((value >> 4) & 1),
    targetBackdrop: Boolean((value >> 5) & 1),
    mode: (value >> 6) & 0x3,
    secondTargetsBg: [0, 1, 2, 3].filter((n) => (value >> (8 + n)) & 1),
    secondTargetObj: Boolean((value >> 12) & 1),
    secondTargetBackdrop: Boolean((value >> 13) & 1),
  };
}

/**
 * 8 位域的同一套混合（@gba-kit 用的就是这套）。
 *
 * 保留它不是为了发货，而是为了**诊断**：真机（GBATEK）在 15 位域算，
 * 8 位域算出来的亮度结果会差 1~2 个 8 位级；如果两边都跑一遍，
 * 就能立刻分清"我算错了"还是"参照实现选了另一种口径"。
 */
export function blend8(top8, back8, {mode = BLEND_MODE.NONE, eva = 16, evb = 0, evy = 16} = {}) {
  if (mode === BLEND_MODE.ALPHA) {
    const a = Math.min(16, eva);
    const b = Math.min(16, evb);
    return [
      Math.min(255, (top8[0] * a + back8[0] * b) >> 4),
      Math.min(255, (top8[1] * a + back8[1] * b) >> 4),
      Math.min(255, (top8[2] * a + back8[2] * b) >> 4),
    ];
  }
  if (mode === BLEND_MODE.BRIGHTEN) {
    const y = Math.min(16, evy);
    return [
      Math.min(255, top8[0] + (((255 - top8[0]) * y) >> 4)),
      Math.min(255, top8[1] + (((255 - top8[1]) * y) >> 4)),
      Math.min(255, top8[2] + (((255 - top8[2]) * y) >> 4)),
    ];
  }
  if (mode === BLEND_MODE.DARKEN) {
    const y = Math.min(16, evy);
    return [
      Math.max(0, top8[0] - ((top8[0] * y) >> 4)),
      Math.max(0, top8[1] - ((top8[1] * y) >> 4)),
      Math.max(0, top8[2] - ((top8[2] * y) >> 4)),
    ];
  }
  return [top8[0], top8[1], top8[2]];
}
