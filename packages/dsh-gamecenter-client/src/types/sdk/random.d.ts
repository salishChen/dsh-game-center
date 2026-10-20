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
export function hashSeed(seedInput: string | number): number;
/**
 * 创建受管确定性随机数实例。
 * @param {string | number} [initialSeed]
 */
export function createSeededRandom(initialSeed?: string | number): {
    next: () => number;
    nextInt: (min: number, max: number) => number;
    getState: () => string;
    setState: (stateStr: string) => void;
};
