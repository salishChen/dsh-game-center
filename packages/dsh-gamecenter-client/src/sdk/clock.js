// @ts-check
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
export function createGameClock(options = {}) {
  const getWallTime = options.getWallTime ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let elapsedMs = Math.max(0, options.initialElapsedMs ?? 0);
  let isFrozen = true;
  let lastResumeWallTime = 0;

  /**
   * 启动/继续累积游戏时间。
   */
  function resume() {
    if (!isFrozen) return;
    isFrozen = false;
    lastResumeWallTime = getWallTime();
  }

  /**
   * 暂停/冻结虚拟时钟，结算上一段活跃时间。
   */
  function pause() {
    if (isFrozen) return;
    const now = getWallTime();
    elapsedMs += Math.max(0, now - lastResumeWallTime);
    isFrozen = true;
  }

  /**
   * 获取当前累计游戏虚拟毫秒数。
   * @returns {number}
   */
  function getElapsedMs() {
    if (isFrozen) {
      return Math.round(elapsedMs);
    }
    const currentSegment = Math.max(0, getWallTime() - lastResumeWallTime);
    return Math.round(elapsedMs + currentSegment);
  }

  /**
   * 获取是否处于冻结状态。
   * @returns {boolean}
   */
  function isClockFrozen() {
    return isFrozen;
  }

  /**
   * 从存档恢复时重置累计虚拟时间。
   * @param {number} newElapsedMs
   */
  function reset(newElapsedMs = 0) {
    pause();
    elapsedMs = Math.max(0, newElapsedMs);
  }

  return {
    resume,
    pause,
    getElapsedMs,
    isClockFrozen,
    reset,
  };
}
