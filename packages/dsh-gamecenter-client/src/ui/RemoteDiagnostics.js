// @ts-check
/**
 * 游戏中心阶段0 Remote 连接状态与只读模型诊断组件。
 *
 * 稳定性与交互改进：
 * 1. 消除点击死锁与租约串扰：重测或组件卸载时立即调用 abort() 中止旧轮次，杜绝向 Host 发送迟到写请求。
 * 2. 校准全局超时预算：整轮有界超时设为 15000ms（15s），避免 7 步正常累积耗时被误杀。
 * 3. 初始挂载状态即刻可见：初次渲染即呈现 7 项基础框架，彻底消除空白占位死锁。
 * 4. 错误信息捕获呈现：任何同步或异步异常直接转化为 UI 状态行展示，绝不静默吞没。
 */

// @ts-expect-error 运行时由 DSH 静态外部表提供
import { createElement as h, useState, useEffect, useCallback, useRef } from 'react';
import { GLOBAL_TIMEOUT_MS } from '../bridge/diagnostics.js';

/**
 * 错误脱敏与截断处理
 * @param {any} err
 * @returns {string}
 */
function toErrorMessage(err) {
  if (!err) return '未知错误';
  const raw = typeof err === 'string' ? err : err.message || String(err);
  const clean = raw.replace(/[\r\n]+/g, ' ').trim();
  return clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
}

/**
 * @param {{
 *   remoteState: { failure: string | null, mounted: boolean },
 *   getService: () => any,
 *   makeNonce: () => string,
 *   runDiagnostics: (params: any) => Promise<import('../bridge/diagnostics.js').DiagnosticRow[]>
 * }} props
 */
export function RemoteDiagnostics({ remoteState, getService, makeNonce, runDiagnostics }) {
  const [loading, setLoading] = useState(false);
  /** @type {[import('../bridge/diagnostics.js').DiagnosticRow[], Function]} */
  const [rows, setRows] = useState([]);
  const [fatalError, setFatalError] = useState(/** @type {string | null} */ (null));
  const runSequenceRef = useRef(0);
  const activeTimerRef = useRef(/** @type {any} */ (null));
  const abortControllerRef = useRef(/** @type {AbortController | null} */ (null));

  const clearTimer = () => {
    if (activeTimerRef.current !== null) {
      if (typeof globalThis.clearTimeout === 'function') {
        globalThis.clearTimeout(activeTimerRef.current);
      }
      activeTimerRef.current = null;
    }
  };

  const abortPreviousRun = () => {
    if (abortControllerRef.current !== null) {
      try {
        abortControllerRef.current.abort();
      } catch {
        // ignore
      }
      abortControllerRef.current = null;
    }
  };

  // 组件卸载时：立刻清理定时器并中止正在进行的后台请求
  useEffect(() => {
    return () => {
      clearTimer();
      abortPreviousRun();
    };
  }, []);

  const execute = useCallback(async () => {
    const seq = ++runSequenceRef.current;
    clearTimer();
    abortPreviousRun();

    const ctrl = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
    abortControllerRef.current = ctrl;

    setLoading(true);
    setFatalError(null);

    // 全局有界超时兜底（15000ms）：避免异常未知挂起，同时保证正常 7 步调用不被误杀
    if (typeof globalThis.setTimeout === 'function') {
      activeTimerRef.current = globalThis.setTimeout(() => {
        if (seq !== runSequenceRef.current) return;
        abortPreviousRun();
        setLoading(false);
        setRows((/** @type {any[]} */ prev) => {
          const list = Array.isArray(prev) ? prev : [];
          if (list.length > 0) return list;
          return [
            {
              key: 'timeout',
              label: '诊断初始化',
              status: 'fail',
              value: '检测请求超时（15秒未响应），请检查客户端与 Remote 服务通信状态',
            },
          ];
        });
      }, GLOBAL_TIMEOUT_MS);
    }

    try {
      if (typeof runDiagnostics !== 'function') {
        throw new Error('未提供有效的 runDiagnostics 诊断执行器');
      }

      let client = null;
      try {
        client = typeof getService === 'function' ? getService() : null;
      } catch (svcErr) {
        throw new Error(`获取服务客户端失败: ${toErrorMessage(svcErr)}`);
      }

      await runDiagnostics({
        remoteState: remoteState || { failure: null, mounted: false },
        client,
        makeNonce: typeof makeNonce === 'function' ? makeNonce : () => String(Date.now()),
        signal: ctrl?.signal,
        onRow: (/** @type {any} */ updatedRow) => {
          // 仅接收当前执行轮次的行更新，丢弃过时轮次的回调
          if (seq !== runSequenceRef.current) return;
          setRows((/** @type {any[]} */ prev) => {
            const list = Array.isArray(prev) ? prev : [];
            const copy = [...list];
            const idx = copy.findIndex((r) => r.key === updatedRow.key);
            if (idx >= 0) copy[idx] = updatedRow;
            else copy.push(updatedRow);
            return copy;
          });
        },
      });
    } catch (err) {
      if (seq !== runSequenceRef.current) return;
      const anyErr = /** @type {any} */ (err);
      if (anyErr.code === 'ABORTED' || ctrl?.signal.aborted) {
        return;
      }
      const errMsg = toErrorMessage(err);
      setFatalError(errMsg);
      setRows((/** @type {any[]} */ prev) => {
        const list = Array.isArray(prev) ? prev : [];
        const copy = [...list];
        const idx = copy.findIndex((r) => r.key === 'exec_error');
        const errRow = {
          key: 'exec_error',
          label: '诊断执行异常',
          status: /** @type {const} */ ('fail'),
          value: `异常中断: ${errMsg}`,
        };
        if (idx >= 0) copy[idx] = errRow;
        else copy.push(errRow);
        return copy;
      });
    } finally {
      if (seq === runSequenceRef.current) {
        clearTimer();
        setLoading(false);
      }
    }
  }, [remoteState, getService, makeNonce, runDiagnostics]);

  useEffect(() => {
    void execute();
  }, [remoteState?.mounted, remoteState?.failure]);

  const getStatusBadge = (/** @type {string} */ status) => {
    let color = '#888';
    let bg = 'rgba(128,128,128,0.1)';
    let text = '等待';
    if (status === 'ok') {
      color = '#10b981';
      bg = 'rgba(16,185,129,0.12)';
      text = '正常';
    } else if (status === 'fail') {
      color = '#ef4444';
      bg = 'rgba(239,68,68,0.12)';
      text = '失败';
    } else if (status === 'warn') {
      color = '#f59e0b';
      bg = 'rgba(245,158,11,0.12)';
      text = '告警';
    } else if (status === 'pending') {
      color = '#3b82f6';
      bg = 'rgba(59,130,246,0.12)';
      text = '检测中';
    } else if (status === 'skip') {
      color = '#9ca3af';
      bg = 'rgba(156,163,175,0.12)';
      text = '跳过';
    }
    return h(
      'span',
      {
        style: {
          display: 'inline-block',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: '500',
          color,
          background: bg,
        },
      },
      text,
    );
  };

  const renderEmptyOrPlaceholder = () => {
    if (fatalError) {
      return h(
        'tr',
        null,
        h(
          'td',
          { colSpan: 3, style: { padding: '12px', textAlign: 'center', color: '#ef4444' } },
          `诊断执行异常: ${fatalError} (可点击右上角重试)`,
        ),
      );
    }
    if (loading) {
      return h(
        'tr',
        null,
        h(
          'td',
          { colSpan: 3, style: { padding: '12px', textAlign: 'center', color: '#3b82f6' } },
          '正在执行远程检测，请稍候…',
        ),
      );
    }
    return h(
      'tr',
      null,
      h(
        'td',
        { colSpan: 3, style: { padding: '12px', textAlign: 'center', color: '#888' } },
        '尚未启动检测，可点击右上角「重新检测」',
      ),
    );
  };

  return h(
    'section',
    {
      'data-testid': 'gamecenter-diagnostics-panel',
      style: CONTAINER_STYLE,
      'aria-label': 'Remote 连通性与模型只读诊断',
    },
    h(
      'div',
      { style: HEADER_STYLE },
      h(
        'div',
        null,
        h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: '600' } }, '阶段0 链路诊断与模型目录'),
        h(
          'span',
          { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #888)' } },
          '契约对账: SERVICE_KEY=gameCenter (两端一致) · 独立探针 (无付费/无模型调用)',
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () => void execute(),
          disabled: loading,
          style: REFRESH_BTN_STYLE,
          'aria-busy': loading ? 'true' : 'false',
        },
        loading ? '检测中…' : '重新检测',
      ),
    ),
    h(
      'table',
      { style: TABLE_STYLE },
      h(
        'tbody',
        null,
        Array.isArray(rows) && rows.length > 0
          ? rows.map((r) =>
              h(
                'tr',
                { key: r.key, style: ROW_STYLE },
                h('td', { style: LABEL_COL_STYLE }, r.label),
                h('td', { style: BADGE_COL_STYLE }, getStatusBadge(r.status)),
                h(
                  'td',
                  {
                    style: VALUE_COL_STYLE,
                    title: r.value,
                  },
                  r.value,
                ),
              ),
            )
          : renderEmptyOrPlaceholder(),
      ),
    ),
  );
}

const CONTAINER_STYLE = Object.freeze({
  margin: '12px 0',
  padding: '12px',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-subtle, rgba(0,0,0,0.03))',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.08))',
});

const HEADER_STYLE = Object.freeze({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '8px',
});

const REFRESH_BTN_STYLE = Object.freeze({
  padding: '3px 8px',
  fontSize: '11px',
  borderRadius: '4px',
  border: '1px solid var(--dsw-alias-border-l3, #ccc)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
});

const TABLE_STYLE = Object.freeze({
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '12px',
});

const ROW_STYLE = Object.freeze({
  borderBottom: '1px solid var(--dsw-alias-border-l4, rgba(0,0,0,0.04))',
});

const LABEL_COL_STYLE = Object.freeze({
  padding: '6px 4px',
  width: '170px',
  fontWeight: '500',
  whiteSpace: 'nowrap',
});

const BADGE_COL_STYLE = Object.freeze({
  padding: '6px 4px',
  width: '56px',
});

const VALUE_COL_STYLE = Object.freeze({
  padding: '6px 4px',
  color: 'var(--dsw-alias-label-secondary, #444)',
  wordBreak: 'break-all',
});
