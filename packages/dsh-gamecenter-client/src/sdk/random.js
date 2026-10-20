// @ts-check
/**
 * 确定性种子伪随机数发生器（Mulberry32 算法）。
 *
 * 契约保证（基线 §6、§8.2）：
 * 1. 同一初始种子产生完全相同的伪随机数序列。
 * 2. 支持导出状态 (getState) 与恢复状态 (setState)，恢复后随机序列不跳变、不补跑。
 * 3. 状态序列化为紧凑字符串，可安全放入 GameSaveV1.rngState。
 */

/**
 * 字符串哈希为 32 位无符号整数种子。
 * @param {string | number} seedInput
 * @returns {number}
 */
export function hashSeed(seedInput) {
  if (typeof seedInput === 'number') {
    return (seedInput >>> 0) || 1;
  }
  const str = String(seedInput);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return h || 1;
}

/**
 * 创建受管确定性随机数实例。
 * @param {string | number} [initialSeed]
 */
export function createSeededRandom(initialSeed = 1) {
  let s = hashSeed(initialSeed);

  /**
   * Mulberry32 步进核心，生成 [0, 1) 的浮点数。
   * @returns {number}
   */
  function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * 生成包含 min 和 max 的整数。
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function nextInt(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (lo >= hi) return lo;
    return Math.floor(next() * (hi - lo + 1)) + lo;
  }

  /**
   * 导出当前 PRNG 内部状态。
   * @returns {string}
   */
  function getState() {
    return s.toString(16).padStart(8, '0');
  }

  /**
   * 恢复 PRNG 内部状态。
   * @param {string} stateStr
   */
  function setState(stateStr) {
    if (typeof stateStr !== 'string' || stateStr.length === 0) {
      throw new Error('无效的 rngState 状态字符串');
    }
    const parsed = parseInt(stateStr, 16);
    if (Number.isNaN(parsed)) {
      throw new Error(`无法解析的 rngState: "${stateStr}"`);
    }
    s = parsed >>> 0;
  }

  return {
    next,
    nextInt,
    getState,
    setState,
  };
}
