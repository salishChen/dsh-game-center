/**
 * 游戏会话：把内核、存档池、自动存档拧成一条能被 UI 直接用的线
 *
 * 人类要的四件事在这里闭环：
 *   - 手动存档/读档（无上限）
 *   - 每 5 分钟自动存档（最多 20 份，满了删最旧）—— 由 save-pool + auto-saver 负责
 *   - 关闭游戏时先存一份（进自动池，reason 'close'）
 *   - 坏档/版本不符不覆盖好档，并给出人话错误
 *
 * 它不做：渲染、按键映射、钱包。那些在外面，避免这里长成一个上帝对象。
 */

import {createSavePool} from './save-pool.js';
import {createAutoSaver} from './auto-saver.js';

/**
 * @param {object} options
 * @param {{snapshot:Function, restore:Function}} options.bridge savestate 桥
 * @param {object} options.store 存档池存储抽象（IndexedDB 或内存实现）
 * @param {() => string} [options.gameVersion]
 * @param {() => number} [options.now]
 * @param {number} [options.autoIntervalMs] 默认 5 分钟
 * @param {object} [options.timers] 测试注入的定时器
 * @param {(error:unknown) => void} [options.onError]
 */
export function createGameSession(options) {
  const bridge = options?.bridge;
  if (!bridge || typeof bridge.snapshot !== 'function' || typeof bridge.restore !== 'function') {
    throw new TypeError('createGameSession 需要 bridge（snapshot/restore）');
  }
  const gameVersion = options.gameVersion ?? (() => '0.0.0');

  const pool = createSavePool({
    store: options.store,
    now: options.now,
    gameVersion,
  });

  const autoSaver = createAutoSaver({
    capture: () => bridge.snapshot(),
    save: (snapshot, reason) => pool.save({payload: snapshot, reason}),
    intervalMs: options.autoIntervalMs,
    now: options.now,
    timers: options.timers,
    onError: options.onError,
  });

  return {
    pool,
    autoSaver,

    /** 开始计时（进入游戏时调一次）。 */
    start() {
      return autoSaver.start();
    },

    /** 手动存档：无上限，进手动池。 */
    saveManual(name) {
      return pool.save({payload: bridge.snapshot(), reason: 'manual', name});
    },

    /**
     * 读档。成功才动内核；失败（坏档/版本不符）原样返回错误，
     * **绝不因为读失败去覆盖别的存档**。
     */
    async load(slot) {
      const result = await pool.load(slot);
      if (!result.ok) return result;
      const restored = bridge.restore(result.payload);
      if (!restored.ok) {
        return {ok: false, code: 'KERNEL_REJECTED', message: restored.reason};
      }
      return {ok: true, meta: result.meta, payload: result.payload};
    },

    /** 关闭游戏：先存 reason 'close'（进自动池），再停调度器。页面要 await 它。 */
    close() {
      return autoSaver.shutdown('close');
    },

    listAll() {
      return pool.listAll();
    },

    autoUsage() {
      return pool.autoUsage();
    },

    remove(slot) {
      return pool.remove(slot);
    },
  };
}
