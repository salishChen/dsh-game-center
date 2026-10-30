/**
 * 自动存档调度器
 *
 * 人类的原话：「关闭游戏时先自动存档，每隔一段时间进行自动存档，自动存档每隔5分钟一次」。
 *
 * 这个模块只管**什么时候存**，不管存什么、也不管淘汰（那是 save-pool 的事）。
 *
 * 几条硬要求（都是把"自动存档"做砸的常见方式）：
 * - **不许并发**：上一份还没写完，下一份不能开始（fp 会写坏索引，存档池的队列虽能串行，
 *   但这里要先挡住，否则 5 分钟一次的全量 savestate 会排队堆积）。
 * - **不许重入**：同一时刻只允许一个 tick 在跑。
 * - **暂停/停止后不再触发**：pagehide 之后不应再有定时器把状态写进池。
 * - **失败不自杀**：一次写失败不能让调度器停摆，也不能吞掉错误——交回给调用方回调。
 */

/**
 * @param {object} options
 * @param {() => any} options.capture 取当前状态（同步返回 payload）
 * @param {(payload:any, reason:string) => Promise<any>} options.save 交给存档池
 * @param {number} [options.intervalMs] 默认 5 分钟
 * @param {() => number} [options.now]
 * @param {(error:unknown) => void} [options.onError]
 * @param {{setInterval:Function, clearInterval:Function}} [options.timers] 测试注入
 */
export function createAutoSaver(options) {
  const capture = options?.capture;
  const save = options?.save;
  if (typeof capture !== 'function' || typeof save !== 'function') {
    throw new TypeError('createAutoSaver 需要 capture() 与 save(payload, reason)');
  }
  const intervalMs = Number.isInteger(options.intervalMs) ? options.intervalMs : 5 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const onError = options.onError ?? (() => {});
  const timers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };

  let handle = null;
  let running = false; // 是否已 start
  let inFlight = false; // 当前是否有一次存档在跑
  let lastSavedAt = null;
  let lastError = null;
  let saveCount = 0;

  async function runOnce(reason) {
    if (inFlight) return {skipped: true, code: 'IN_FLIGHT'};
    inFlight = true;
    try {
      const payload = capture();
      const result = await save(payload, reason);
      lastSavedAt = now();
      saveCount += 1;
      lastError = null;
      return {skipped: false, reason, savedAt: lastSavedAt, result};
    } catch (error) {
      lastError = error;
      onError(error);
      return {skipped: false, reason, error};
    } finally {
      inFlight = false;
    }
  }

  return {
    get isRunning() {
      return running;
    },

    get stats() {
      return {running, inFlight, lastSavedAt, lastError, saveCount, intervalMs};
    },

    start() {
      if (running) return {started: false, code: 'ALREADY_RUNNING'};
      running = true;
      handle = timers.setInterval(() => {
        // 定时器回调不 await：runOnce 自己防重入
        void runOnce('auto');
      }, intervalMs);
      // Node 里别让定时器把进程吊住
      if (handle && typeof handle.unref === 'function') handle.unref();
      return {started: true, intervalMs};
    },

    stop() {
      if (!running) return {stopped: false, code: 'NOT_RUNNING'};
      running = false;
      if (handle !== null) {
        timers.clearInterval(handle);
        handle = null;
      }
      return {stopped: true};
    },

    /** 手动触发一次（测试与"立即存档"按钮用）。 */
    tick(reason = 'auto') {
      return runOnce(reason);
    },

    /**
     * 关闭游戏时用：先存一份进自动池（reason 'close'），再停调度器。
     * 返回的 promise 必须被页面 await（pagehide 里要给浏览器一个机会写完）。
     */
    async shutdown(reason = 'close') {
      const result = await runOnce(reason);
      this.stop();
      return result;
    },
  };
}
