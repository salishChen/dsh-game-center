/**
 * 存档池（游戏侧策略层）
 *
 * 只做策略，不做存储：
 * - 手动池：无上限，`pool:'manual'`
 * - 自动池：上限 20 份（`autoLimit`），满了淘汰**最旧的一份自动存档**
 * - 关闭游戏时那次存档进**自动池**，`reason:'close'`（它不是玩家主动存的，混进手动池会稀释手动池）
 * - 单写者队列：定时器与"关闭"可能撞在同一秒，任何时刻只有一个写在跑
 * - 读档先校验 checksum，坏档不覆盖好档
 * - 版本不兼容必须显式报错，不许静默失败
 *
 * 存储抽象（由插件/平台提供，IndexedDB 或测试用内存实现）：
 *   list()            -> Promise<Array<Meta>>
 *   read(slot)        -> Promise<{meta, payload} | null>
 *   write(slot, rec)  -> Promise<void>     // rec = {meta, payload}
 *   remove(slot)      -> Promise<void>
 *
 * Meta = {slot, pool:'manual'|'auto', reason, createdAt, gameVersion, bytes, checksum}
 */

export const SAVE_SCHEMA = 1;
export const AUTO_POOL_LIMIT = 20;
export const REASONS = Object.freeze(['manual', 'auto', 'close']);

/** 无加密的稳定摘要，只用来发现截断/损坏，不是安全边界。 */
export function checksumOf(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = (Math.imul(h1 ^ c, 0x01000193) >>> 0);
    h2 = (Math.imul(h2 + c, 0x27d4eb2d) >>> 0);
  }
  return `c1:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function byCreatedAsc(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return String(a.slot) < String(b.slot) ? -1 : 1;
}

/**
 * @param {object} options
 * @param {object} options.store 存储抽象
 * @param {() => number} [options.now] 注入时钟（毫秒），测试可控
 * @param {number} [options.autoLimit] 自动池上限，默认 20
 * @param {() => string} [options.gameVersion] 当前游戏版本
 */
export function createSavePool(options) {
  const store = options?.store;
  if (!store || typeof store.list !== 'function' || typeof store.write !== 'function') {
    throw new TypeError('createSavePool 需要 store（list/read/write/remove）');
  }
  const now = options.now ?? (() => Date.now());
  const autoLimit = Number.isInteger(options.autoLimit) ? options.autoLimit : AUTO_POOL_LIMIT;
  const gameVersion = options.gameVersion ?? (() => '0.0.0');

  /** 单写者队列：串行化所有写事务，避免索引并发写坏。 */
  let tail = Promise.resolve();
  function serialize(task) {
    const run = tail.then(task, task);
    // 吞掉拒绝只为让队列继续，错误仍从 run 抛给调用者
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  function normalizeReason(reason) {
    return REASONS.includes(reason) ? reason : 'auto';
  }

  async function listAll() {
    const metas = (await store.list()) ?? [];
    return metas.slice().sort(byCreatedAsc);
  }

  /** 自动池超额时淘汰最旧的自动存档（手动池不受影响）。 */
  async function evictIfNeeded() {
    const autos = (await listAll()).filter((m) => m.pool === 'auto');
    const overflow = autos.length - autoLimit;
    if (overflow <= 0) return [];
    const doomed = autos.slice(0, overflow);
    for (const meta of doomed) {
      await store.remove(meta.slot);
    }
    return doomed.map((m) => m.slot);
  }

  return {
    listAll,

    async listPool(pool) {
      return (await listAll()).filter((m) => m.pool === pool);
    },

    /**
     * 存一份。手动/自动/关闭三种来源共用，池与淘汰规则按 reason 决定。
     * @returns {Promise<{meta: object, evicted: string[]}>}
     */
    save({ payload, reason = 'auto', slot, name } = {}) {
      return serialize(async () => {
        const kind = normalizeReason(reason);
        const pool = kind === 'manual' ? 'manual' : 'auto';
        const createdAt = now();
        const finalSlot = slot ?? `${pool}-${createdAt}`;
        const meta = {
          slot: finalSlot,
          pool,
          reason: kind,
          name: name ?? null,
          createdAt,
          gameVersion: gameVersion(),
          bytes: typeof payload === 'string' ? payload.length : JSON.stringify(payload ?? null).length,
          checksum: checksumOf(payload ?? null),
          schema: SAVE_SCHEMA,
        };
        await store.write(finalSlot, { meta, payload });
        const evicted = await evictIfNeeded();
        return { meta, evicted };
      });
    },

    /** 关闭游戏时调用：一律进自动池，reason:'close'。 */
    saveOnClose(payload) {
      return this.save({ payload, reason: 'close' });
    },

    /**
     * 读一份并校验。坏档/版本不符都返回显式错误，调用方不得据此覆盖其它存档。
     * @returns {Promise<{ok:true, meta:object, payload:any} | {ok:false, code:string, message:string}>}
     */
    async load(slot) {
      const rec = await store.read(slot);
      if (!rec) return { ok: false, code: 'NOT_FOUND', message: `存档不存在：${slot}` };
      const { meta, payload } = rec;
      if (!meta || meta.checksum !== checksumOf(payload ?? null)) {
        return { ok: false, code: 'CORRUPT', message: `存档校验失败（可能已损坏）：${slot}` };
      }
      const current = gameVersion();
      if (meta.gameVersion && meta.gameVersion !== current) {
        return {
          ok: false,
          code: 'VERSION_MISMATCH',
          message: `此存档来自 ${meta.gameVersion}，当前版本 ${current}，无法读取`,
        };
      }
      return { ok: true, meta, payload };
    },

    remove(slot) {
      return serialize(() => store.remove(slot));
    },

    /** 自动池当前占用，供 UI 显示「19/20」。 */
    async autoUsage() {
      const autos = await this.listPool('auto');
      return { used: autos.length, limit: autoLimit };
    },
  };
}
