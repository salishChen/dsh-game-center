// @ts-check
/**
 * 受限 iframe 游戏文档组装器与安全内联（基线 §7、阶段1 生产接线核心）。
 *
 * 核心安全机制与设计依据（严格对齐 packages/protocol/src/wiring.ts）：
 * 1. 严格沙箱隔离：iframe 必须且只能设置 sandbox="allow-scripts"（绝不含 allow-same-origin）。
 *    游戏运行在 opaque origin 下，无法访问宿主 window、主 DOM、cookie、localStorage 或通用 RPC。
 * 2. 强安全 CSP 断网：文档写入 GAME_DOCUMENT_CSP meta 标签，default-src 'none'、connect-src 'none'，
 *    彻底切断一切网络请求能力（禁止 fetch、XHR、WebSocket）。
 * 3. 本地资源安全内联：由于 opaque origin 无法相对父源请求资源，组装器将受限白名单文本资产全部内联化：
 *    - <link rel="stylesheet" href="./style.css"> -> 内联 <style>
 *    - <script src="./game.js"></script> -> 内联 <script>
 *    - 严禁任何 http(s): 绝对外链，违者直接拒绝。
 * 4. 纵深防御文件校验：执行 validateGameBundleFiles，强校验文件数（<=64）、单文件（<=1MB）、
 *    总大小（<=32MB，容纳离线 Flash/WASM）与后缀白名单，杜绝路径逃逸。
 * 5. SDK 引导注入：在游戏脚本执行前注入微型引导脚本，利用 MessagePort 完成与宿主 Bridge 的通信，
 *    挂载 window.__DSH_GAMECENTER_SDK__，实现虚拟时钟、确定性随机数与暂停保存闭环。
 */

import { utf8ByteLength } from '../bridge/host-bridge.js';

export const GAME_IFRAME_SANDBOX = 'allow-scripts';

export const GAME_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

export const GAME_BUNDLE_MAX_FILES = 64;
// 【与 protocol 常量同值 · 2026-10-27】浏览器侧不能直接引用 protocol 的构建期常量，
// 这里保持 30 MiB / 50 MiB 与其一致；改一侧必须同时改另一侧（protocol/src/wiring.ts:238-239）。
export const GAME_BUNDLE_MAX_FILE_BYTES = 30 * 1024 * 1024;
export const GAME_BUNDLE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const GAME_BUNDLE_MAX_PATH_LENGTH = 256;

export const GAME_BUNDLE_TEXT_EXTENSIONS = Object.freeze([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.txt',
  '.svg',
]);

/**
 * 判断相对路径是否安全且在白名单内。
 * @param {string} p
 * @returns {boolean}
 */
export function isSafeBundlePath(p) {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > GAME_BUNDLE_MAX_PATH_LENGTH) return false;
  if (p.endsWith('/') || p.startsWith('/') || p.includes('\\')) return false;
  if (p.includes('..') || p.includes(':')) return false;

  const lower = p.toLowerCase();
  return GAME_BUNDLE_TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * 校验 bundle 文件清单是否符合安全规范。
 * @param {any[]} files
 * @returns {{field: string, reason: string}[]}
 */
export function validateGameBundleFiles(files) {
  const violations = [];
  if (!Array.isArray(files)) {
    return [{ field: 'files', reason: 'files 必须是数组' }];
  }
  if (files.length === 0) {
    return [{ field: 'files', reason: 'files 不能为空' }];
  }
  if (files.length > GAME_BUNDLE_MAX_FILES) {
    violations.push({ field: 'files', reason: `文件数 ${files.length} 超过上限 ${GAME_BUNDLE_MAX_FILES}` });
  }

  const seen = new Set();
  let total = 0;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    if (!f || typeof f !== 'object') {
      violations.push({ field: `files[${i}]`, reason: '文件项必须是对象' });
      continue;
    }
    if (typeof f.path !== 'string') {
      violations.push({ field: `files[${i}].path`, reason: 'path 必须是字符串' });
      continue;
    }
    const norm = f.path.replace(/^\.?\//, '');
    if (!isSafeBundlePath(norm)) {
      violations.push({ field: `files[${i}].path`, reason: `路径不安全或后缀不在白名单: ${f.path}` });
    }
    if (seen.has(norm)) {
      violations.push({ field: `files[${i}].path`, reason: `文件路径重复: ${norm}` });
    }
    seen.add(norm);

    if (typeof f.content !== 'string') {
      violations.push({ field: `files[${i}].content`, reason: 'content 必须是 UTF-8 文本字符串' });
      continue;
    }
    const bytes = utf8ByteLength(f.content);
    if (bytes > GAME_BUNDLE_MAX_FILE_BYTES) {
      violations.push({ field: `files[${i}].content`, reason: `单文件 ${bytes} 字节超过上限 ${GAME_BUNDLE_MAX_FILE_BYTES}` });
    }
    total += bytes;
  }

  if (total > GAME_BUNDLE_MAX_TOTAL_BYTES) {
    violations.push({ field: 'files', reason: `总字节数 ${total} 超过上限 ${GAME_BUNDLE_MAX_TOTAL_BYTES}` });
  }

  return violations;
}

/**
 * 校验沙箱与 CSP 策略是否满足安全隔离红线。
 * @param {string} sandbox
 * @param {string} csp
 * @returns {{field: string, reason: string}[]}
 */
export function validateFramePolicy(sandbox, csp) {
  const violations = [];
  const tokens = (sandbox || '').split(/\s+/).filter(Boolean);
  if (tokens.length !== 1 || tokens[0] !== 'allow-scripts') {
    violations.push({
      field: 'sandbox',
      reason: `sandbox 必须严格为 "allow-scripts"，实际为 ${JSON.stringify(sandbox)}`,
    });
  }
  for (const item of ["default-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    if (!csp.includes(item)) {
      violations.push({ field: 'csp', reason: `CSP 必须包含 "${item}"` });
    }
  }
  if (/connect-src\s+(?!'none')/.test(csp)) {
    violations.push({ field: 'csp', reason: "CSP 的 connect-src 必须恒为 'none'" });
  }
  return violations;
}

/**
 * 生成在 iframe 内先于游戏运行的轻量 SDK 引导脚本。
 * @param {object} options
 * @param {string} options.runtimeInstanceId
 * @param {string} options.nonce
 * @param {string | number} [options.initialSeed]
 * @param {string} [options.initialRngState]
 * @param {number} [options.initialElapsedMs]
 * @param {number} [options.initialRevision]
 * @returns {string}
 */
export function generateSdkBootstrapSource(options) {
  const {
    runtimeInstanceId,
    nonce,
    initialSeed = 1,
    initialRngState = '',
    initialElapsedMs = 0,
    initialRevision = 0,
  } = options;

  return `(function() {
  'use strict';
  function createSeededRandom(seed) {
    let s = 0;
    if (typeof seed === 'number') s = seed >>> 0;
    else if (typeof seed === 'string') {
      for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    } else s = 1;
    if (s === 0) s = 1;
    let a = s;
    function next() {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      next: next,
      nextInt: function(min, max) { return Math.floor(next() * (max - min + 1)) + min; },
      getState: function() { return (a >>> 0).toString(16).padStart(8, '0'); },
      setState: function(str) { a = parseInt(str, 16) >>> 0; if (a === 0) a = 1; }
    };
  }

  function createGameClock(opts) {
    let elapsed = opts && typeof opts.initialElapsedMs === 'number' ? opts.initialElapsedMs : 0;
    let frozen = true;
    let lastTime = null;
    return {
      resume: function() {
        if (!frozen) return;
        frozen = false;
        lastTime = Date.now();
      },
      pause: function() {
        if (frozen) return;
        if (lastTime !== null) elapsed += Date.now() - lastTime;
        frozen = true;
        lastTime = null;
      },
      getElapsedMs: function() {
        if (frozen || lastTime === null) return elapsed;
        return elapsed + (Date.now() - lastTime);
      },
      isClockFrozen: function() { return frozen; },
      reset: function(val) { elapsed = typeof val === 'number' ? val : 0; lastTime = frozen ? null : Date.now(); }
    };
  }

  let boundPort = null;
  const pendingRequests = new Map();
  let lifecycleHooks = null;
  let lastKnownRevision = ${Number(initialRevision) || 0};
  let lastAttemptedOperationId = null;
  let lastAttemptedExpectedRevision = lastKnownRevision;
  let actionSeq = 0;
  const sdkInstanceId = Math.random().toString(36).slice(2, 10);
  const operationPayloadCache = new Map();
  let reqSeq = 0;

  const clock = createGameClock({ initialElapsedMs: ${Number(initialElapsedMs) || 0} });
  const random = createSeededRandom(${JSON.stringify(initialSeed)});
  const initialRng = ${JSON.stringify(initialRngState)};
  if (typeof initialRng === 'string' && initialRng.length > 0) {
    random.setState(initialRng);
  }

  function nextRequestId() {
    reqSeq += 1;
    return 'req-' + Date.now().toString(36) + '-' + reqSeq;
  }

  function sendRequest(method, payload) {
    return new Promise(function(resolve, reject) {
      if (!boundPort) {
        reject(new Error('MessagePort 尚未就绪'));
        return;
      }
      const requestId = nextRequestId();
      pendingRequests.set(requestId, { resolve: resolve, reject: reject });
      try {
        boundPort.postMessage({
          bridgeVersion: 1,
          requestId: requestId,
          method: method,
          payload: payload || {}
        });
      } catch (postErr) {
        pendingRequests.delete(requestId);
        reject(postErr);
      }
    });
  }

  function onPortMessage(event) {
    const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
    if (!data || typeof data !== 'object') return;

    // 【主题下发 · v3】协议唯一契约：host.push 信封。
    // { kind:'host.push', event:'theme', seq:<单增整数>, payload:{ mode:'light'|'dark', source:'dsh'|'os' } }
    // 只接受经**已配对 MessagePort** 到达的推送；这条 port 是握手
    // （event.source + 一次性 nonce + runtimeInstanceId 三者校验通过）之后才建立的，
    // 来源天然可信，绝不为主题另开 window 消息监听。
    // seq 单增：丢弃乱序/重复推送。
    if (data.kind === 'host.push') {
      if (data.event !== 'theme') return;
      if (typeof data.seq !== 'number' || !Number.isSafeInteger(data.seq) || data.seq <= 0) return;
      if (data.seq <= lastThemeSeq) return; // 乱序/重复
      const payload = data.payload;
      if (payload === null || typeof payload !== 'object') return;
      const mode = payload.mode;
      if (mode !== 'dark' && mode !== 'light') return;
      const source = payload.source;
      if (source !== 'dsh' && source !== 'os') return;
      lastThemeSeq = data.seq;
      currentTheme = mode;
      for (const fn of [...themeListeners]) {
        try { fn(mode, source); } catch (e) { console.error(e); }
      }
      return;
    }

    if (typeof data.requestId === 'string') {
      const handler = pendingRequests.get(data.requestId);
      if (handler) {
        pendingRequests.delete(data.requestId);
        if (data.ok === true) {
          handler.resolve(data.payload);
        } else {
          const errObj = data.error || {};
          const err = new Error(errObj.message || 'Bridge 请求失败');
          err.code = errObj.code || 'UNKNOWN';
          err.retryable = Boolean(errObj.retryable);
          err.currentRevision = errObj.currentRevision;
          handler.reject(err);
        }
      }
      return;
    }

    if (data.type === 'lifecycle:control') {
      const action = data.action;
      if (action !== 'suspend' && action !== 'resume') return;
      (async function() {
        try {
          let controlSnapshot;
          if (action === 'suspend') {
            clock.pause();
            if (lifecycleHooks && typeof lifecycleHooks.pause === 'function') controlSnapshot = await lifecycleHooks.pause();
          } else {
            if (lifecycleHooks && typeof lifecycleHooks.resume === 'function') await lifecycleHooks.resume();
            clock.resume();
          }
          boundPort.postMessage({bridgeVersion:1, requestId:'ack-' + data.controlId, method:'lifecycle.controlAck', payload:{controlId:data.controlId, generation:data.generation, ok:true,...(controlSnapshot === undefined ? {} : {snapshot:controlSnapshot})}});
        } catch (error) {
          boundPort.postMessage({bridgeVersion:1, requestId:'ack-' + data.controlId, method:'lifecycle.controlAck', payload:{controlId:data.controlId, generation:data.generation, ok:false, message:String(error)}});
        }
      })();
      return;
    }

    if (data.type === 'lifecycle:pause') {
      clock.pause();
      const generation = Number(data.generation) || 0;
      (async function() {        try {
          let snapshot = null;
          if (lifecycleHooks && typeof lifecycleHooks.pause === 'function') {
            snapshot = await lifecycleHooks.pause();
          }
          if (boundPort) {
            boundPort.postMessage({
              bridgeVersion: 1,
              requestId: nextRequestId(),
              method: 'lifecycle.pauseAck',
              payload: {
                generation: generation,
                revision: lastKnownRevision,
                snapshot: snapshot || {},
                elapsedGameMs: clock.getElapsedMs(),
                rngState: random.getState()
              }
            });
          }
        } catch (hookErr) {
          console.error('[GameCenterSDK] lifecycle.pause 执行失败:', hookErr);
        }
      })();
      return;
    }

    if (data.type === 'lifecycle:resume') {
      clock.resume();
      if (lifecycleHooks && typeof lifecycleHooks.resume === 'function') {
        try { lifecycleHooks.resume(); } catch (e) {}
      }
    }
  }

  const queuedCalls = [];

  // 【主题通道 · v3】主题只经**已配对的 MessagePort** 下发，绝不监听 window 的
  // theme-change 字符串消息（可被任意来源伪造）。DSH 显式主题优先于 OS 偏好；
  // preference === 'system' 时才跟随 OS。
  let currentTheme = 'light';
  /** 主题推送的已处理最大 seq（丢弃乱序/重复）。 */
  let lastThemeSeq = 0;
  /** @type {Set<(theme: string, source: string) => void>} */
  const themeListeners = new Set();

  window.addEventListener('message', function onInitPort(event) {
    if (event.data && event.data.type === 'dsh-gamecenter:port' && event.ports && event.ports[0]) {
      window.removeEventListener('message', onInitPort);
      boundPort = event.ports[0];
      boundPort.onmessage = onPortMessage;
      if (typeof boundPort.start === 'function') boundPort.start();

      while (queuedCalls.length > 0) {
        const fn = queuedCalls.shift();
        try { fn(); } catch (e) { console.error(e); }
      }
    }
  });

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({
      tag: 'dsh-gamecenter:hello',
      runtimeInstanceId: ${JSON.stringify(runtimeInstanceId)},
      nonce: ${JSON.stringify(nonce)},
      bridgeVersion: 1
    }, '*');
  }

  window.__DSH_GAMECENTER_SDK__ = {
    wallet: {
      command: function(input) {
        if (!boundPort) return new Promise(function(resolve,reject) { queuedCalls.push(function() { window.__DSH_GAMECENTER_SDK__.wallet.command(input).then(resolve,reject); }); });
        return sendRequest('wallet.command',input);
      }
    },
    game: {
      command: function(input) {
        if (!boundPort) return new Promise(function(resolve,reject) { queuedCalls.push(function() { window.__DSH_GAMECENTER_SDK__.game.command(input).then(resolve,reject); }); });
        return sendRequest('game.command', input);
      }
    },
    ai: {
      generate: function(request) {
        if (!boundPort) {
          return new Promise(function(resolve, reject) {
            queuedCalls.push(function() {
              window.__DSH_GAMECENTER_SDK__.ai.generate(request).then(resolve, reject);
            });
          });
        }
        if (!request || !request.slot || !request.operationId) {
          return Promise.reject(new Error('ai.generate 必须提供 slot 与 operationId'));
        }
        return sendRequest('ai.generate', request);
      },
      cancel: function(request) {
        if (!boundPort) {
          return new Promise(function(resolve, reject) {
            queuedCalls.push(function() {
              window.__DSH_GAMECENTER_SDK__.ai.cancel(request).then(resolve, reject);
            });
          });
        }
        if (!request || !request.operationId) {
          return Promise.reject(new Error('ai.cancel 必须提供 operationId'));
        }
        return sendRequest('ai.cancel', request);
      }
    },
    // 【主题 · v3】当前主题（'light' | 'dark'）与订阅。
    // 初值与变化都只来自已配对 MessagePort 上的协议 host.push 信封；
    // DSH 显式主题（source='dsh'）优先于 OS 偏好（source='os'）。
    theme: {
      /** @returns {string} */
      get: function() { return currentTheme; },
      /**
       * @param {(theme: string, source: 'dsh' | 'os') => void} listener
       * @returns {() => void} 取消订阅
       */
      subscribe: function(listener) {
        if (typeof listener !== 'function') return function() {};
        themeListeners.add(listener);
        return function() { themeListeners.delete(listener); };
      }
    },
    save: {
      checkpoint: function(gameState, opts) {
        if (!boundPort) {
          return new Promise(function(resolve, reject) {
            queuedCalls.push(function() {
              window.__DSH_GAMECENTER_SDK__.save.checkpoint(gameState, opts).then(resolve, reject);
            });
          });
        }
        let operationId = '';
        const isRetry = Boolean(opts && (opts.retry || opts.isRetry));
        if (opts && typeof opts.operationId === 'string' && opts.operationId.trim().length > 0) {
          operationId = opts.operationId.trim();
        } else if (isRetry && typeof lastAttemptedOperationId === 'string') {
          operationId = lastAttemptedOperationId;
        } else {
          actionSeq += 1;
          operationId = 'act-' + sdkInstanceId + '-' + actionSeq;
        }

        const cached = operationPayloadCache.get(operationId);
        let state;
        let elapsedGameMs;
        let rngState;
        let expectedRevision;

        if (cached && (isRetry || (opts && opts.operationId === operationId))) {
          state = gameState !== undefined ? (gameState || null) : cached.state;
          elapsedGameMs = cached.elapsedGameMs;
          rngState = cached.rngState;
          expectedRevision = opts && typeof opts.expectedRevision === 'number' ? opts.expectedRevision : cached.expectedRevision;
        } else {
          state = gameState || null;
          elapsedGameMs = clock.getElapsedMs();
          rngState = random.getState();
          expectedRevision = opts && typeof opts.expectedRevision === 'number' ? opts.expectedRevision : lastKnownRevision;
          operationPayloadCache.set(operationId, { state: state, elapsedGameMs: elapsedGameMs, rngState: rngState, expectedRevision: expectedRevision });
          if (operationPayloadCache.size > 64) {
            const firstKey = operationPayloadCache.keys().next().value;
            if (firstKey) operationPayloadCache.delete(firstKey);
          }
        }

        lastAttemptedOperationId = operationId;
        lastAttemptedExpectedRevision = expectedRevision;

        return sendRequest('save.checkpoint', {
          operationId: operationId,
          expectedRevision: expectedRevision,
          state: state,
          elapsedGameMs: elapsedGameMs,
          rngState: rngState
        }).then(function(result) {
          if (result && typeof result.revision === 'number') {
            lastKnownRevision = result.revision;
          }
          return {
            revision: result ? result.revision : lastKnownRevision,
            idempotentReplay: Boolean(result && result.idempotentReplay),
            operationId: operationId
          };
        }).catch(function(err) {
          err.operationId = operationId;
          err.expectedRevision = expectedRevision;
          throw err;
        });
      }
    },
    lifecycle: {
      ready: function() {
        clock.resume();
        if (!boundPort) {
          return new Promise(function(resolve, reject) {
            queuedCalls.push(function() {
              window.__DSH_GAMECENTER_SDK__.lifecycle.ready().then(resolve, reject);
            });
          });
        }
        return sendRequest('lifecycle.ready', {});
      },
      register: function(hooks) {
        lifecycleHooks = hooks;
      }
    },
    clock: clock,
    random: random,
    assets: {
      resolve: function(assetId) {
        if (typeof assetId !== 'string' || assetId.includes('..') || assetId.startsWith('/')) {
          throw new Error('非法资产路径，禁止路径逃逸');
        }
        return assetId;
      }
    }
  };
})();`;
}

/**
 * 校验 CSS 内容：严禁 at-import 和非 data: 的 url() 外部引用。
 * @param {string} css
 * @param {string} sourceName
 */
export function validateCssContent(css, sourceName) {
  if (/@import\b/i.test(css)) {
    throw new Error(`安全防御拦截: CSS 中严禁使用 @import (${sourceName})`);
  }
  const urlMatch = css.match(/url\s*\(\s*['"]?(?!data:)([^'")]+)['"]?\s*\)/i);
  if (urlMatch) {
    throw new Error(`安全防御拦截: CSS 中严禁使用非 data: 的 url() 引用: ${urlMatch[1]} (${sourceName})`);
  }
}

/**
 * 校验 HTML 结构与标签白名单策略。
 * @param {string} html
 */
export function validateHtmlSecurity(html) {
  // 提取纯 HTML 标记骨架（剥离 script、style 内部代码与注释，避免 JS/CSS 中的比较运算符误判为 HTML 标签）
  const htmlMarkupOnly = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<!--[\s\S]*?-->/g, '');

  // 1. 禁止危险/未支持标签（在纯 HTML 标记骨架中检索）
  const forbiddenTagMatch = htmlMarkupOnly.match(/<\s*\/?\s*(iframe|object|embed|base|form|applet|frame|frameset)\b[^>]*>/i);
  if (forbiddenTagMatch) {
    throw new Error(`安全防御拦截: 严禁包含未受支持的标签: ${forbiddenTagMatch[0]}`);
  }

  // 2. 禁止 meta refresh 等跳转出口
  if (/<meta\b[^>]*\bhttp-equiv\s*=\s*['"]?refresh\b/i.test(htmlMarkupOnly)) {
    throw new Error('安全防御拦截: 严禁包含 meta refresh 跳转出口');
  }

  // 3. 禁止 srcset 与 formaction 等未处理属性
  if (/\bsrcset\s*=/i.test(htmlMarkupOnly)) {
    throw new Error('安全防御拦截: 严禁包含 srcset 属性');
  }
  if (/\bformaction\s*=/i.test(htmlMarkupOnly)) {
    throw new Error('安全防御拦截: 严禁包含 formaction 属性');
  }

  // 4. 校验内联 style="..." 属性内容
  const inlineStyleMatches = htmlMarkupOnly.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi);
  for (const sm of inlineStyleMatches) {
    const styleContent = sm[1] ?? sm[2] ?? '';
    validateCssContent(styleContent, 'style 属性');
  }

  // 5. 校验 <img> 标签：仅允许 data: URI，其余本地或远程引用在阶段1均显式拒绝
  const imgMatches = htmlMarkupOnly.matchAll(/<img\b([^>]*?)>/gi);
  for (const m of imgMatches) {
    const attrs = m[1] ?? '';
    const srcMatch = attrs.match(/\bsrc\s*=\s*['"]?([^"'\s>]+)['"]?/i);
    if (srcMatch && srcMatch[1] && !srcMatch[1].startsWith('data:')) {
      throw new Error(`安全防御拦截: 严禁未转为 data: URI 的 img 引用: ${srcMatch[1]}`);
    }
  }

  // 6. 校验 SVG 中的远程引用（如 <image href="..." /> 或 <use href="..." />）
  const svgRefMatch = htmlMarkupOnly.match(/<\s*(?:image|use)\b[^>]*\b(?:href|xlink:href)\s*=\s*['"]?([^"'\s>]+)['"]?/i);
  if (svgRefMatch && svgRefMatch[1] && !svgRefMatch[1].startsWith('data:') && !svgRefMatch[1].startsWith('#')) {
    throw new Error(`安全防御拦截: 严禁未转为 data: URI 的 SVG 外部资源引用: ${svgRefMatch[1]}`);
  }

  // 7. 校验 <script> 标签：禁止远程 module import、动态 import
  const scriptMatches = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const sm of scriptMatches) {
    const attrs = sm[1] ?? '';
    const scriptBody = sm[2] ?? '';
    if (/\btype\s*=\s*['"]?module['"]?/i.test(attrs) || /\bimport\s*\(/i.test(scriptBody) || /\bimport\b[\s\S]*?\bfrom\s*['"][^'"]*['"]/i.test(scriptBody)) {
      if (/(?:https?:|\/\/)/i.test(scriptBody) || /\btype\s*=\s*['"]?module['"]?/i.test(attrs)) {
        throw new Error('安全防御拦截: 严禁在脚本中使用 module import 或远程 import');
      }
    }
  }

  // 8. 校验已存在的内联 <style> 标签内容
  const styleMatches = html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi);
  for (const stm of styleMatches) {
    const styleBody = stm[1] ?? '';
    validateCssContent(styleBody, '内联 <style>');
  }
}

/**
 * 组装完全内联化的受限游戏 iframe 文档。
 *
 * @param {object} params
 * @param {string} params.entryPath 游戏入口路径（例如 "dist/index.html" 或 "index.html"）
 * @param {Array<{path: string, content: string}>} params.files 游戏包文件列表
 * @param {object} params.options 运行实例参数
 * @param {string} params.options.runtimeInstanceId
 * @param {string} params.options.nonce
 * @param {string | number} [params.options.initialSeed]
 * @param {string} [params.options.initialRngState]
 * @param {number} [params.options.initialElapsedMs]
 * @param {number} [params.options.initialRevision]
 * @returns {string} 组装完成的单文档 HTML
 */
export function assembleGameDocument({ entryPath, files, options }) {
  const violations = validateGameBundleFiles(files);
  if (violations.length > 0) {
    throw new Error('Bundle 文件校验不合格: ' + violations.map((v) => `${v.field} (${v.reason})`).join(', '));
  }

  const normEntry = (entryPath || 'index.html').replace(/^\.?\//, '');
  const entryFile = files.find((f) => f.path.replace(/^\.?\//, '') === normEntry);
  if (!entryFile) {
    throw new Error(`未在 bundle 文件列表中找到指定的入口文件: ${entryPath}`);
  }

  const entryDir = normEntry.includes('/') ? normEntry.slice(0, normEntry.lastIndexOf('/')) : '';

  /**
   * 将 relative path 解析为相对于 bundle root 的安全 path
   * @param {string} rel
   */
  const resolveTarget = (rel) => {
    const clean = rel.replace(/^\.?\//, '');
    return entryDir ? `${entryDir}/${clean}`.replace(/\/\//g, '/') : clean;
  };

  let html = entryFile.content;

  // 0. 执行初始 HTML 安全策略审查（拦截危险标签、未转化的本地/远程 img、已存在的非法 script/style 等）
  validateHtmlSecurity(html);

  // 1. 拦截外部链接与内联 CSS
  // 匹配形如 <link rel="stylesheet" href="..."> 或 <link href="..." rel="stylesheet">
  html = html.replace(/<link\b([^>]*?)>/gi, (tag, attrs) => {
    if (!/rel=["']?stylesheet["']?/i.test(attrs)) {
      throw new Error(`安全防御拦截: 未受支持的 link 标签: ${tag}`);
    }

    const hrefMatch = attrs.match(/href=["']?([^"'\s>]+)["']?/i);
    if (!hrefMatch) return tag;

    const href = hrefMatch[1];
    if (/^(https?:|\/\/)/i.test(href)) {
      throw new Error(`安全防御拦截: 禁止外部样式链接 ${href}`);
    }

    const targetPath = resolveTarget(href);
    const matchedFile = files.find((f) => f.path.replace(/^\.?\//, '') === targetPath);
    if (!matchedFile) {
      throw new Error(`缺少依赖样式文件: ${targetPath}`);
    }

    // 校验被内联样式安全合规性（禁止 @import、非 data: url() 等）
    validateCssContent(matchedFile.content, targetPath);

    return `<style data-inlined="${targetPath}">\n${matchedFile.content}\n</style>`;
  });

  // 2. 拦截外部脚本与内联 JS
  // 匹配形如 <script src="..."></script>
  html = html.replace(/<script\b([^>]*?)src=["']?([^"'\s>]+)["']?([^>]*?)>\s*<\/script>/gi, (tag, before, src, after) => {
    if (/^(https?:|\/\/)/i.test(src)) {
      throw new Error(`安全防御拦截: 禁止外部脚本链接 ${src}`);
    }

    const targetPath = resolveTarget(src);
    const matchedFile = files.find((f) => f.path.replace(/^\.?\//, '') === targetPath);
    if (!matchedFile) {
      throw new Error(`缺少依赖脚本文件: ${targetPath}`);
    }

    // 检查是否有 module 关键字或远程 import
    if (/\btype\s*=\s*['"]?module['"]?/i.test(before + after) || /\bimport\s*\(|\bimport\b[\s\S]*?\bfrom/i.test(matchedFile.content)) {
      if (/(?:https?:|\/\/)/i.test(matchedFile.content) || /\btype\s*=\s*['"]?module['"]?/i.test(before + after)) {
        throw new Error(`安全防御拦截: 严禁在脚本中使用 module import 或远程 import (${targetPath})`);
      }
    }

    // 【ESM 产物拦截】内联进经典 <script> 的必须是已打包的 IIFE/UMD。
    // 若游戏把**源码版 ESM**（含顶层 export）当成 dist 产物提交，内联后浏览器会报
    // "Unexpected token 'export'" 这类难懂的语法错，且错误点在合成文档里、难以定位。
    // 这里提前拦截并给出可操作的提示（请先打包成自包含产物）。
    if (/(^|[\n;{}])\s*export\s+(default|const|let|var|function|class|\{|\*)/m.test(matchedFile.content)) {
      throw new Error(
        `安全防御拦截: ${targetPath} 含有顶层 export（ESM 源码），不能直接内联为经典脚本。` +
          '请提交已打包的自包含产物（IIFE/UMD），或把该脚本声明为 type="module" 并改用模块化装配路径。',
      );
    }

    return `<script data-inlined="${targetPath}"${before}${after}>\n/* inlined: ${targetPath} */\n${matchedFile.content}\n</script>`;
  });

  // 3. 检查是否有未处理的外链残留
  if (/<link\b[^>]*\bhref\b/i.test(html)) {
    throw new Error('安全防御拦截: 存在未处理的外部 link 引用');
  }
  if (/<script\b[^>]*\bsrc\b/i.test(html)) {
    throw new Error('安全防御拦截: 存在未处理的外部 script 引用');
  }

  // 4. 强置 CSP Meta 标签
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${GAME_DOCUMENT_CSP}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n  ${cspMeta}`);
  } else {
    html = `${cspMeta}\n${html}`;
  }

  // 5. 注入 SDK 引导脚本（必须先于游戏脚本执行）
  const bootstrapCode = generateSdkBootstrapSource(options);
  const bootstrapTag = `<script data-gamecenter-bootstrap>\n${bootstrapCode}\n</script>`;

  if (/<script\b/i.test(html)) {
    // 插入在第一个 <script> 之前
    html = html.replace(/<script\b/i, (m) => `${bootstrapTag}\n${m}`);
  } else if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, (m) => `${bootstrapTag}\n${m}`);
  } else {
    html = `${html}\n${bootstrapTag}`;
  }

  // 6. 最终安全整体验证
  validateHtmlSecurity(html);

  return html;
}
