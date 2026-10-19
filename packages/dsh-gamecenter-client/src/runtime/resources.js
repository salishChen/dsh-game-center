/**
 * 运行时资源清理表（基线 §7 末尾、§8.1 第 5 步）。
 *
 * 游戏的所有 Worker、音频、动画帧、定时器、事件监听、订阅、MessagePort
 * 都必须登记到这里；销毁时按**注册逆序**释放一次，重复调用是幂等的。
 * 这不是 DSH API，是游戏中心自己的资源账本。
 */

/** @typedef {(kind: string) => void} Releaser */

/** @typedef {'iframe'|'worker'|'audio'|'raf'|'timer'|'listener'|'subscription'|'port'} ResourceKind */

/**
 * @typedef {object} ResourceTable
 * @property {(kind: ResourceKind, dispose: () => void) => () => void} track
 * @property {() => {released: number, kinds: Record<string, number>, errors: string[]}} releaseAll
 * @property {() => {count: number, kinds: Record<string, number>}} outstanding
 * @property {boolean} disposed
 */

/** @returns {ResourceTable} */
export function createResourceTable() {
  /** @type {{kind: string, dispose: () => void}[]} */
  let entries = [];
  let disposed = false;

  /**
   * 登记一个可释放资源。
   * @param {ResourceKind} kind 资源种类
   * @param {() => void} dispose 幂等释放函数
   * @returns {() => void} 提前释放该资源的句柄（会同时从账本移除）
   */
  function track(kind, dispose) {
    if (disposed) {
      // 销毁后再登记等于立即泄漏：立刻释放，避免静默吞掉。
      try {
        dispose();
      } catch {
        /* 已记录在销毁阶段，这里不再抛出 */
      }
      return () => {};
    }
    /** @type {{kind: string, dispose: () => void}} */
    const entry = { kind, dispose };
    entries.push(entry);
    return () => {
      const index = entries.indexOf(entry);
      if (index === -1) return;
      entries.splice(index, 1);
      dispose();
    };
  }

  /**
   * 释放全部资源（逆序），返回实际释放的条目数与种类统计，供测试断言。
   * @returns {{released: number, kinds: Record<string, number>, errors: string[]}}
   */
  function releaseAll() {
    if (disposed) return { released: 0, kinds: {}, errors: [] };
    disposed = true;
    /** @type {Record<string, number>} */
    const kinds = {};
    /** @type {string[]} */
    const errors = [];
    let released = 0;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      try {
        entry.dispose();
        released += 1;
        kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
      } catch (error) {
        errors.push(`${entry.kind}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    entries = [];
    return { released, kinds, errors };
  }

  /**
   * 当前仍持有的资源（泄漏检查用）。
   * @returns {{count: number, kinds: Record<string, number>}}
   */
  function outstanding() {
    /** @type {Record<string, number>} */
    const kinds = {};
    for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
    return { count: entries.length, kinds };
  }

  return {
    track,
    releaseAll,
    outstanding,
    get disposed() {
      return disposed;
    },
  };
}
