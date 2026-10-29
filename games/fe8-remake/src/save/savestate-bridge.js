/**
 * savestate 桥：把内核存档接进存档池
 *
 * 形状（冻结，路线定案后不再改）：
 *   snapshot() -> { schema, gameVersion, payload }   // payload = 内核 savestate（纯对象 + TypedArray）
 *   restore(payload) -> { ok, reason? }
 *   meta() -> { gameVersion, chapter, turn, playtimeMs }
 *
 * 关键取舍：
 * - **两个池同格式**（完整 savestate）。不做"自动档只存轻量档"这种降级：
 *   SRAM 里只有游戏内存档点，自动档回滚到它会变成"跳回上次存档点"，
 *   而人类要的是"关掉的那一刻"，语义不同，不能悄悄换。
 * - payload 必须是结构化克隆友好的（内核 serialize 已满足），可以直接丢进 IndexedDB。
 */

export const SNAPSHOT_SCHEMA = 1;

/**
 * @param {object} options
 * @param {{snapshot:Function, restore:Function}} options.kernel 内核适配层
 * @param {() => string} [options.gameVersion]
 * @param {() => object} [options.readMeta] 采集章节/回合等轻量信息（可选）
 */
export function createSavestateBridge(options) {
  const kernel = options?.kernel;
  if (!kernel || typeof kernel.snapshot !== 'function' || typeof kernel.restore !== 'function') {
    throw new TypeError('createSavestateBridge 需要 kernel（snapshot/restore）');
  }
  const gameVersion = options.gameVersion ?? (() => '0.0.0');
  const readMeta = options.readMeta ?? (() => ({}));

  return {
    snapshot() {
      const payload = kernel.snapshot();
      if (!payload || typeof payload !== 'object') {
        throw new TypeError('内核 snapshot 必须返回对象（纯对象 + TypedArray）');
      }
      return {schema: SNAPSHOT_SCHEMA, gameVersion: gameVersion(), payload};
    },

    /** @returns {{ok:true} | {ok:false, reason:string}} */
    restore(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') {
        return {ok: false, reason: '快照不是对象'};
      }
      if (snapshot.schema !== SNAPSHOT_SCHEMA) {
        return {ok: false, reason: `快照 schema 不兼容：需要 ${SNAPSHOT_SCHEMA}，实际 ${String(snapshot.schema)}`};
      }
      const payload = snapshot.payload;
      if (!payload || typeof payload !== 'object') {
        return {ok: false, reason: '快照缺少 payload'};
      }
      try {
        kernel.restore(payload);
      } catch (error) {
        return {ok: false, reason: `内核拒绝该快照：${error instanceof Error ? error.message : String(error)}`};
      }
      return {ok: true};
    },

    meta() {
      return {gameVersion: gameVersion(), ...readMeta()};
    },
  };
}
