// @ts-check
/**
 * DSH 主题桥（v3：主题经已配对 MessagePort 下发给游戏）。
 *
 * 【为什么必须走配对 port】主题是玩家可见状态。若游戏侧监听 `window` 的
 * theme-change 字符串消息，任意同页脚本都能伪造，把游戏刷成错误配色。
 * 因此本桥只在拿到 dispatcher 之后，经**已配对的 MessagePort** 下发；
 * 那条 port 是握手（`event.source` + 一次性 nonce + `runtimeInstanceId`
 * 三者校验通过）之后才建立的，来源天然可信。
 *
 * 【DSH 优先于 OS】DSH 主题服务的 `active.colorScheme` 是宿主显式状态；
 * 只有当宿主 `preference === 'system'` 时才由 DSH 自己解析 OS 后再反映到
 * `active`。所以本桥**只读 `active.colorScheme`**，不自己去读
 * `prefers-color-scheme`——那会绕过宿主的显式锁定。
 *
 * 【取不到主题服务时】不猜、不默认深色：保持 `available: false`，
 * 游戏侧沿用自身默认（light），并且不报错（主题缺失不是阻断性故障）。
 */

/**
 * @typedef {object} ThemeBridge
 * @property {boolean} available 是否拿到 DSH 主题服务
 * @property {() => 'dark' | 'light' | null} current 当前主题（拿不到返回 null）
 * @property {(send: (scheme: 'dark' | 'light') => boolean) => () => void} bind
 *   绑定一个下发函数，返回取消订阅函数
 * @property {() => void} dispose 释放订阅
 */

/**
 * 从 DSH ctx 上取主题服务（只读探测，不假设接口形状）。
 *
 * DSH 权威源（架构负责人实读 `@deepseek-ai/dsh-client-ui-theme@0.2.1-rc.2`）：
 * `ctx.provide('theme')` 提供、`ctx.on('theme/change')` 订阅、
 * `getTheme().active.colorScheme` 取值。
 *
 * @param {any} ctx DSH 插件上下文
 * @returns {any | null}
 */
function resolveThemeService(ctx) {
  if (ctx === null || typeof ctx !== 'object') return null;
  // 优先走 provide（权威注入点）
  if (typeof ctx.provide === 'function') {
    try {
      const provided = ctx.provide('theme');
      if (provided !== null && provided !== undefined) return provided;
    } catch {
      // provide 不可用或未注册主题服务 → 继续尝试其他入口
    }
  }
  // 回退：某些装配把服务直接挂在 ctx 上
  if (ctx.theme !== null && ctx.theme !== undefined) return ctx.theme;
  if (typeof ctx.get === 'function') {
    try {
      const got = ctx.get('theme');
      if (got !== null && got !== undefined) return got;
    } catch {
      // 忽略
    }
  }
  return null;
}

/**
 * 从主题服务里读出当前 colorScheme 与来源。
 * @param {any} service
 * @returns {{mode: 'dark' | 'light', source: 'dsh' | 'os'} | null}
 */
function readTheme(service) {
  if (service === null || typeof service !== 'object') return null;
  /** @type {any} */
  let theme = null;
  // 形状 1：getTheme()
  if (typeof service.getTheme === 'function') {
    try {
      theme = service.getTheme();
    } catch {
      theme = null;
    }
  }
  // 形状 2：服务本身就是 theme 对象
  if (theme === null || typeof theme !== 'object') theme = service;

  const scheme = theme.active?.colorScheme ?? theme.colorScheme;
  if (scheme !== 'dark' && scheme !== 'light') return null;

  // source：DSH 显式主题（'dsh'）优先于 OS 偏好（'os'）。
  // 宿主的 preference 为 'system' 时表示跟随 OS，此时来源标记为 'os'。
  const preference = theme.preference ?? service.preference;
  const source = preference === 'system' ? 'os' : 'dsh';
  return { mode: scheme, source };
}

/**
 * 创建主题桥。
 *
 * @param {any} ctx DSH 插件上下文
 * @returns {ThemeBridge}
 */
export function createThemeBridge(ctx) {
  const service = resolveThemeService(ctx);
  /** @type {Set<(mode: 'dark' | 'light', source: 'dsh' | 'os') => boolean>} */
  const senders = new Set();
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /**
   * @param {'dark' | 'light'} mode
   * @param {'dsh' | 'os'} source
   */
  const broadcast = (mode, source) => {
    for (const send of [...senders]) {
      try {
        send(mode, source);
      } catch {
        // 单个游戏下发失败不影响其他游戏
      }
    }
  };

  // 订阅 DSH 主题变化
  if (service !== null && typeof service.on === 'function') {
    try {
      const off = service.on('theme/change', () => {
        const next = readTheme(service);
        if (next !== null) broadcast(next.mode, next.source);
      });
      if (typeof off === 'function') unsubscribe = off;
    } catch {
      // 订阅失败不影响取值
    }
  }

  return {
    available: service !== null,
    current() {
      const theme = readTheme(service);
      return theme === null ? null : theme.mode;
    },
    /**
     * @param {(mode: 'dark' | 'light', source: 'dsh' | 'os') => boolean} send
     * @returns {() => void}
     */
    bind(send) {
      senders.add(send);
      // 绑定后立即下发一次初值（游戏启动时就要有正确配色）
      const initial = readTheme(service);
      if (initial !== null) {
        try {
          send(initial.mode, initial.source);
        } catch {
          // 忽略
        }
      }
      return () => {
        senders.delete(send);
      };
    },
    dispose() {
      senders.clear();
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe();
        } catch {
          // 忽略
        }
      }
      unsubscribe = null;
    },
  };
}
