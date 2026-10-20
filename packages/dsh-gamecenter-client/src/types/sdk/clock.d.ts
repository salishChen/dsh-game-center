/**
 * 游戏受管虚拟时钟（GameClock）。
 *
 * 契约保证（基线 §6、§8.1、§8.2）：
 * 1. 虚拟时钟仅在 Running 活跃阶段累计游戏时间（elapsedGameMs）。
 * 2. 暂停流程启动时立刻冻结时钟，防止关闭期间倒计时或定时器按现实时间偷跑。
 * 3. 恢复运行时从持久化的 elapsedGameMs 接续，不按现实世界挂钟时间补跑。
 */
/**
 * @param {object} [options]
 * @param {number} [options.initialElapsedMs] 初始累计游戏时间（从存档恢复时传入）
 * @param {() => number} [options.getWallTime] 宿主现实时间源（默认 performance.now 或 Date.now）
 */
export function createGameClock(options?: {
    initialElapsedMs?: number | undefined;
    getWallTime?: (() => number) | undefined;
}): {
    resume: () => void;
    pause: () => void;
    getElapsedMs: () => number;
    isClockFrozen: () => boolean;
    reset: (newElapsedMs?: number) => void;
};
