// @ts-check
/**
 * 游戏中心阶段0 最小无付费 Remote 诊断核心逻辑。
 *
 * 契约与安全硬约束：
 * 1. 独立探针实例：使用专用 gameId（`__gamecenter_diag__`），生成独立 runtimeInstanceId。
 * 2. 同一链条复用：saveId 是**存档槽位**（固定 `save-default`），与 runtimeInstanceId 分离；
 *    链内所有依赖租约的探针（handshake / leaseStatus / pause / saveAck）复用同一槽位。
 * 3. 严格只读/无付费：modelCatalog 只读元数据，绝不发起 stream/模型调用。
 * 4. 真实结果判定：旧代次 saveAck 必须严格断言 STALE_RUNTIME 错误，不把失败当成功。
 * 5. 错误脱敏：不展示 token 等凭据，错误消息做安全截断。
 * 6. 有界超时与生命周期取消：
 *    - 单次远程 RPC 3000ms 强制超时，全轮具备合理的全局预算（15s），不误杀正常累积步进；
 *    - 完整支持 AbortSignal 取消机制，重测/卸载时立即中止旧轮次，杜绝迟到写入与租约串扰。
 */

export const DIAG_GAME_ID = '__gamecenter_diag__';

/**
 * 诊断链自己的 `launchToken`（协议 2026-10-20 冻结必填）。
 *
 * 诊断是**一次性探针**，不需要"撤销别人实例"的能力，但它必须满足
 * `isLaunchTokenShapeValid()`（32~256 位可见 ASCII、无空白/控制字符）才能过 Host 握手。
 * 固定字面量只为让多轮诊断可复现；真实 UI 路径每次启动都重新生成（见 GameCenterOverlay）。
 */
const LAUNCH_TOKEN_DIAG = 'diag-launch-token-fixed-0000000000000000';

/** 单次远程调用的有界超时上限 (ms) */
export const RPC_TIMEOUT_MS = 3000;

/** 全轮诊断的合理全局超时上限 (ms) */
export const GLOBAL_TIMEOUT_MS = 15000;

/**
 * @typedef {object} DiagnosticRow
 * @property {string} key
 * @property {string} label
 * @property {'pending' | 'ok' | 'fail' | 'warn' | 'skip'} status
 * @property {string} value
 * @property {string} [detail]
 */

/**
 * @param {string} str
 * @param {number} [max]
 * @returns {string}
 */
export function sanitizeMessage(str, max = 120) {
  if (typeof str !== 'string') return '';
  const trimmed = str.replace(/[\r\n]+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + '…';
}

/**
 * 为任意 Promise 提供有界超时与 AbortSignal 取消包装。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function callWithTimeout(promise, timeoutMs, label, signal) {
  if (signal?.aborted) {
    const err = new Error(`${label} 操作已取消（调用前已中断）`);
    /** @type {any} */ (err).code = 'ABORTED';
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    /** @type {any} */
    let timer = null;

    const abortHandler = () => {
      if (timer !== null) clearTimeout(timer);
      const err = new Error(`${label} 操作已取消（外部中止）`);
      /** @type {any} */ (err).code = 'ABORTED';
      reject(err);
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      const err = new Error(`${label} 请求超时（${timeoutMs}ms 未收到响应）`);
      /** @type {any} */ (err).code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);

    promise
      .then((res) => {
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortHandler);
        resolve(res);
      })
      .catch((err) => {
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortHandler);
        reject(err);
      });
  });
}

/**
 * 执行诊断全流程。
 *
 * @param {object} params
 * @param {{ failure: string | null, mounted: boolean }} params.remoteState 客户端当前 $mount 状态
 * @param {any} [params.client] createGameCenterClient 创建的包装客户端
 * @param {() => string} params.makeNonce 生成随机 nonce 的函数
 * @param {(row: DiagnosticRow) => void} [params.onRow] 逐步回调（用于实时更新 UI）
 * @param {AbortSignal} [params.signal] 外部取消信号
 * @returns {Promise<DiagnosticRow[]>}
 */
export async function runRemoteDiagnostics({ remoteState, client, makeNonce, onRow, signal }) {
  /** @type {DiagnosticRow[]} */
  const rows = [];

  /**
   * @param {DiagnosticRow} r
   */
  const emit = (r) => {
    const idx = rows.findIndex((item) => item.key === r.key);
    if (idx >= 0) {
      rows[idx] = r;
    } else {
      rows.push(r);
    }
    onRow?.(r);
  };

  if (signal?.aborted) return rows;

  // 1. 挂载状态检查
  if (!remoteState || !remoteState.mounted) {
    const failMsg = remoteState?.failure ? sanitizeMessage(remoteState.failure) : '未挂载或挂载未完成';
    emit({
      key: 'mount',
      label: 'Remote 挂载 ($mount)',
      status: 'fail',
      value: `失败: ${failMsg}`,
    });
    return rows;
  }

  emit({
    key: 'mount',
    label: 'Remote 挂载 ($mount)',
    status: 'ok',
    value: '已挂载 (ctx.remote.gameCenter 就绪)',
  });

  if (!client) {
    emit({
      key: 'client',
      label: '客户端服务对象',
      status: 'fail',
      value: '缺少有效的客户端实例',
    });
    return rows;
  }

  if (signal?.aborted) return rows;

  const nonce = makeNonce();
  const runtimeInstanceId = `diag-${nonce.length > 16 ? nonce.slice(0, 16) : nonce}`;
  // 存档槽位与运行身份**分离**（2026-10-20 起 Host 不再回退 runtimeInstanceId）。
  // 诊断链内所有依赖租约的探针必须复用同一个 saveId，否则 Host 侧槽位与查询不一致。
  const saveId = 'save-default';
  // 严格使用固定 gameId，依赖 Host 的 runtimeToken 凭证精准定位租约
  const gameId = DIAG_GAME_ID;
  let activeGeneration = 0;
  /** @type {string | null} 仅内存持有，绝不外泄给 UI、日志或 iframe */
  let activeToken = null;

  // 2. 服务可达性与握手 (handshake)
  try {
    emit({ key: 'handshake', label: '服务可达 (handshake)', status: 'pending', value: '握手中…' });
    const hs = await callWithTimeout(
      client.handshake({
        runtimeInstanceId,
        nonce,
        gameId,
        gameVersion: '0.0.0',
        sdkVersion: '0.0.0',
        bridgeVersion: 1,
        saveId,
        // 协议必填：abandonRuntime 用它证明"我就是这个启动的发起者"。
        launchToken: LAUNCH_TOKEN_DIAG,
      }),
      RPC_TIMEOUT_MS,
      'handshake',
      signal,
    );
    if (signal?.aborted) return rows;

    const isObject = hs && typeof hs === 'object';
    const isOk = isObject && hs.ok === true;
    const hasValidGen = isObject && typeof hs.generation === 'number' && Number.isInteger(hs.generation) && hs.generation > 0;
    const hasValidToken = isObject && typeof hs.runtimeToken === 'string' && hs.runtimeToken.length > 0;
    const hasState = isObject && typeof hs.state === 'string' && hs.state.length > 0;

    if (!isOk || !hasValidGen || !hasValidToken || !hasState) {
      const keys = isObject ? Object.keys(hs).join(',') : String(hs);
      emit({
        key: 'handshake',
        label: '服务可达 (handshake)',
        status: 'fail',
        value: `契约异常: 响应缺少必要业务字段 (ok=${hs?.ok}, gen=${hs?.generation}, hasToken=${Boolean(hasValidToken)}, state=${hs?.state}, keys=[${keys}])`,
      });
      activeGeneration = 0;
      activeToken = null;
    } else {
      activeGeneration = hs.generation;
      activeToken = hs.runtimeToken;
      emit({
        key: 'handshake',
        label: '服务可达 (handshake)',
        status: 'ok',
        value: `已连接 (代次 generation=${activeGeneration}, 状态=${hs.state})`,
      });
    }
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    if (anyErr.code === 'ABORTED' || signal?.aborted) return rows;
    const code = anyErr.code || 'UNKNOWN';
    const msg = sanitizeMessage(anyErr.message);
    emit({
      key: 'handshake',
      label: '服务可达 (handshake)',
      status: 'fail',
      value: `握手失败 [${code}]: ${msg}`,
    });
  }

  if (signal?.aborted) return rows;

  // 3. 模型目录读取 (modelCatalog，只读三态)
  try {
    emit({ key: 'catalog', label: '模型目录 (modelCatalog)', status: 'pending', value: '读取中…' });
    const cat = await callWithTimeout(client.modelCatalog(), RPC_TIMEOUT_MS, 'modelCatalog', signal);
    if (signal?.aborted) return rows;

    if (cat && typeof cat === 'object') {
      if (cat.available === true) {
        const count = Array.isArray(cat.entries) ? cat.entries.length : 0;
        const sample = (cat.entries || [])
          .slice(0, 3)
          .map((/** @type {any} */ e) => `${e.providerId}/${e.modelId}`)
          .join(', ');
        emit({
          key: 'catalog',
          label: '模型目录 (modelCatalog)',
          status: 'ok',
          value: `可用 (${count} 个模型)${sample ? `: ${sample}${count > 3 ? '…' : ''}` : ''}`,
        });
      } else if (cat.available === false) {
        const failCount = Array.isArray(cat.failures) ? cat.failures.length : 0;
        const failReason = failCount > 0 ? sanitizeMessage(cat.failures[0]?.error || '') : '模型服务报告不可用';
        emit({
          key: 'catalog',
          label: '模型目录 (modelCatalog)',
          status: 'warn',
          value: `不可用 (failures=${failCount}: ${failReason})`,
        });
      } else {
        const keys = Object.keys(cat).join(',');
        emit({
          key: 'catalog',
          label: '模型目录 (modelCatalog)',
          status: 'fail',
          value: `契约异常: 缺少 available 字段 [keys=${keys}]`,
        });
      }
    } else {
      emit({
        key: 'catalog',
        label: '模型目录 (modelCatalog)',
        status: 'fail',
        value: `契约异常: 返回非对象结构 (${typeof cat})`,
      });
    }
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    if (anyErr.code === 'ABORTED' || signal?.aborted) return rows;
    emit({
      key: 'catalog',
      label: '模型目录 (modelCatalog)',
      status: 'fail',
      value: `获取失败 [${anyErr.code || 'UNKNOWN'}]: ${sanitizeMessage(anyErr.message)}`,
    });
  }

  if (signal?.aborted) return rows;

  /* 如果 handshake 失败未能获得有效 generation 或 runtimeToken，后续与租约强关联的探针全部标记为跳过 */
  if (activeGeneration <= 0 || !activeToken) {
    const skipNotice = !activeToken ? '跳过 (未收到有效 runtimeToken 凭证)' : '跳过 (依赖有效 handshake 代次)';
    emit({ key: 'lease', label: '租约状态 (leaseStatus)', status: 'skip', value: skipNotice });
    emit({ key: 'pause', label: '暂停闭环 (pause)', status: 'skip', value: skipNotice });
    emit({ key: 'staleSave', label: '旧代次拒写 (saveAck)', status: 'skip', value: skipNotice });
    emit({ key: 'saveAck', label: '保存确认 (saveAck)', status: 'skip', value: skipNotice });
    return rows;
  }

  // 4. 租约状态 (leaseStatus)
  try {
    emit({ key: 'lease', label: '租约状态 (leaseStatus)', status: 'pending', value: '查询中…' });
    const ls = await callWithTimeout(
      client.leaseStatus({ runtimeToken: activeToken, gameId, saveId }),
      RPC_TIMEOUT_MS,
      'leaseStatus',
      signal,
    );
    if (signal?.aborted) return rows;

    if (ls.absent) {
      emit({
        key: 'lease',
        label: '租约状态 (leaseStatus)',
        status: 'warn',
        value: '租约不存在 (absent: true)',
      });
    } else {
      emit({
        key: 'lease',
        label: '租约状态 (leaseStatus)',
        status: 'ok',
        value: `状态=${ls.state || 'active'}, 代次=${ls.generation}, 存档版本=${ls.lastPersistedRevision ?? 0}`,
      });
    }
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    if (anyErr.code === 'ABORTED' || signal?.aborted) return rows;
    emit({
      key: 'lease',
      label: '租约状态 (leaseStatus)',
      status: 'fail',
      value: `查询失败 [${anyErr.code || 'UNKNOWN'}]: ${sanitizeMessage(anyErr.message)}`,
    });
  }

  if (signal?.aborted) return rows;

  // 5. 暂停闭环 (pause)
  try {
    emit({ key: 'pause', label: '暂停闭环 (pause)', status: 'pending', value: '请求暂停中…' });
    const p = await callWithTimeout(
      client.pause({ runtimeToken: activeToken, generation: activeGeneration, reason: 'diag' }),
      RPC_TIMEOUT_MS,
      'pause',
      signal,
    );
    if (signal?.aborted) return rows;

    emit({
      key: 'pause',
      label: '暂停闭环 (pause)',
      status: 'ok',
      value: `已进入暂停 (state=${p.state || 'pausing'}, timeoutMs=${p.timeoutMs ?? 3000})`,
    });
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    if (anyErr.code === 'ABORTED' || signal?.aborted) return rows;
    emit({
      key: 'pause',
      label: '暂停闭环 (pause)',
      status: 'fail',
      value: `暂停失败 [${anyErr.code || 'UNKNOWN'}]: ${sanitizeMessage(anyErr.message)}`,
    });
  }

  if (signal?.aborted) return rows;

  // 6. 旧代次拒写 (saveAck with stale generation)
  const staleGen = activeGeneration - 1;
  try {
    emit({
      key: 'staleSave',
      label: '旧代次拒写 (saveAck)',
      status: 'pending',
      value: `发送陈旧代次 generation=${staleGen}…`,
    });
    const res = await callWithTimeout(
      client.saveAck({ runtimeToken: activeToken, generation: staleGen, revision: 1 }),
      RPC_TIMEOUT_MS,
      'saveAck(stale)',
      signal,
    );
    if (signal?.aborted) return rows;

    // 如果没有被拒绝，说明存在安全隔离缺陷！
    emit({
      key: 'staleSave',
      label: '旧代次拒写 (saveAck)',
      status: 'fail',
      value: `异常: 旧代次未被拒绝 (返回 accepted=${res.accepted})`,
    });
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    if (anyErr.code === 'ABORTED' || signal?.aborted) return rows;
    const code = anyErr.code || 'UNKNOWN';
    if (code === 'STALE_RUNTIME') {
      emit({
        key: 'staleSave',
        label: '旧代次拒写 (saveAck)',
        status: 'ok',
        value: `符合预期: 正确拒绝陈旧代次 [STALE_RUNTIME]`,
      });
    } else {
      emit({
        key: 'staleSave',
        label: '旧代次拒写 (saveAck)',
        status: 'fail',
        value: `异常: 被拒绝但错误码非预期 [${code}]: ${sanitizeMessage(anyErr.message)}`,
      });
    }
  }

  if (signal?.aborted) return rows;

  // 7. 正确代次保存确认 (saveAck with current generation)
  try {
    emit({
      key: 'saveAck',
      label: '保存确认 (saveAck)',
      status: 'pending',
      value: `确认代次 generation=${activeGeneration}…`,
    });
    const res = await callWithTimeout(
      client.saveAck({ runtimeToken: activeToken, generation: activeGeneration, revision: 1 }),
      RPC_TIMEOUT_MS,
      'saveAck',
      signal,
    );
    if (signal?.aborted) return rows;

    emit({
      key: 'saveAck',
      label: '保存确认 (saveAck)',
      status: 'ok',
      value: `已保存确认 (state=${res.state || 'paused'}, revision=${res.lastPersistedRevision ?? 1})`,
    });
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    if (anyErr.code === 'ABORTED' || signal?.aborted) return rows;
    emit({
      key: 'saveAck',
      label: '保存确认 (saveAck)',
      status: 'fail',
      value: `保存确认失败 [${anyErr.code || 'UNKNOWN'}]: ${sanitizeMessage(anyErr.message)}`,
    });
  }

  // 8. 放弃启动 (abandonRuntime) —— 2026-10-20 协议冻结的第 13 条方法。
  // 放在最后：此时本轮的 runtimeToken 已封存，重复 abandon 应幂等成功。
  // 只验证"能调用且不抛错"，不把 Host 未实现判成 UI 故障（真实环境由门禁工具报）。
  if (typeof client.abandonRuntime === 'function' && activeToken !== null) {
    try {
      emit({ key: 'abandon', label: '放弃启动 (abandonRuntime)', status: 'pending', value: '取消中…' });
      const res = await callWithTimeout(
        client.abandonRuntime({ launchToken: LAUNCH_TOKEN_DIAG, runtimeInstanceId }),
        RPC_TIMEOUT_MS,
        'abandonRuntime',
        signal,
      );
      if (signal?.aborted) return rows;
      emit({
        key: 'abandon',
        label: '放弃启动 (abandonRuntime)',
        status: 'ok',
        value: `已放弃 (reclaimed=${res?.reclaimed === true})`,
      });
    } catch (err) {
      const anyErr = /** @type {any} */ (err);
      if (anyErr.code === 'ABORTED' || signal?.aborted) return rows;
      emit({
        key: 'abandon',
        label: '放弃启动 (abandonRuntime)',
        status: 'warn',
        value: `不可用 [${anyErr.code || 'UNKNOWN'}]: ${sanitizeMessage(anyErr.message)}`,
      });
    }
  }

  return rows;
}
