// @ts-check
/**
 * v3 主题通道测试：DSH 主题经**已配对 MessagePort** 下发给游戏。
 *
 * 硬约束（PM 四次点名 + 架构负责人实读 DSH 源码）：
 * 1. 主题初值与变化**只**来自已配对的 MessagePort；
 *    **绝不**监听 window 的 theme-change 字符串消息（可被任意来源伪造）；
 * 2. DSH 显式主题**优先于** OS 偏好；
 *    `preference === 'system'` 时才由 DSH 解析 OS 后反映到 `active`；
 * 3. 权威源：`@deepseek-ai/dsh-client-ui-theme@0.2.1-rc.2` 的
 *    `ctx.provide('theme')` / `ctx.on('theme/change')` / `getTheme().active.colorScheme`；
 * 4. 取不到主题服务：不猜、不报错，游戏沿用自身默认；
 * 5. 切换主题**不得**重挂游戏（对局状态、棋盘、时钟、RNG 必须无损）。
 *
 * 运行：node --test test/theme-channel.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 把 theme-bridge 源码转成可在 vm 里执行的 CJS。 */
function loadThemeBridge(sandbox) {
  const src = fs.readFileSync(path.resolve(here, '../src/bridge/theme-bridge.js'), 'utf8');
  const cjs = src
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/@type\s*\{[^}]*\}/g, '')
    .replace(/@param\s*\{[^}]*\}/g, '')
    .replace(/@returns?\s*\{[^}]*\}/g, '')
    .replace(/@typedef[\s\S]*?\n\s*\*\//g, '')
    .replace(/export function (\w+)/g, 'exports.$1 = function $1');
  vm.runInNewContext(cjs, sandbox);
  return sandbox.exports;
}

/** 构造一个可控的假 DSH 主题服务。 */
function makeFakeThemeService(initial) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const state = { active: { colorScheme: initial }, preference: 'explicit' };
  return {
    state,
    getTheme() {
      return { active: { colorScheme: state.active.colorScheme }, preference: state.preference };
    },
    /** @param {string} _type @param {() => void} fn */
    on(_type, fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** @param {'dark' | 'light'} next */
    setScheme(next) {
      state.active.colorScheme = next;
      for (const fn of [...listeners]) fn();
    },
    /**
     * @param {'explicit' | 'system'} pref
     * @param {'dark' | 'light'} resolved
     */
    setPreference(pref, resolved) {
      state.preference = pref;
      state.active.colorScheme = resolved;
      for (const fn of [...listeners]) fn();
    },
  };
}

test('主题桥：能读到 DSH 当前 colorScheme 并支持订阅', () => {
  const sandbox = { exports: {} };
  sandbox.module = { exports: sandbox.exports };
  const { createThemeBridge } = loadThemeBridge(sandbox);

  const service = makeFakeThemeService('light');
  const bridge = createThemeBridge({ provide: (/** @type {string} */ n) => (n === 'theme' ? service : null) });

  assert.equal(bridge.available, true, '必须识别出主题服务');
  assert.equal(bridge.current(), 'light', '初值应读自 DSH');

  /** @type {string[]} */
  const seen = [];
  const unbind = bridge.bind((/** @type {any} */ mode, /** @type {any} */ source) => {
    seen.push(mode + ':' + source);
    return true;
  });
  // bind 后立即下发一次初值（source=dsh 表示 DSH 显式主题优先）
  assert.deepEqual(seen, ['light:dsh'], 'bind 必须立即下发初值');

  service.setScheme('dark');
  assert.deepEqual(seen, ['light:dsh', 'dark:dsh'], 'DSH 主题变化必须被广播');

  unbind();
  service.setScheme('light');
  assert.deepEqual(seen, ['light:dsh', 'dark:dsh'], '解绑后不得再收到');

  bridge.dispose();
});

test('主题桥：取不到主题服务时不猜、不抛错', () => {
  const sandbox = { exports: {} };
  sandbox.module = { exports: sandbox.exports };
  const { createThemeBridge } = loadThemeBridge(sandbox);

  // ctx 完全没有 theme
  const bridge = createThemeBridge({ provide: () => null });
  assert.equal(bridge.available, false, '无主题服务时必须 available=false');
  assert.equal(bridge.current(), null, '取不到必须返回 null，不得默认猜一个');

  /** @type {string[]} */
  const seen = [];
  const unbind = bridge.bind((/** @type {any} */ mode) => {
    seen.push(mode);
    return true;
  });
  assert.deepEqual(seen, [], '无主题服务时不得下发任何值（游戏沿用自身默认）');
  unbind();
  bridge.dispose();
});

test('主题桥：ctx.provide 抛错时回退到其他入口，不崩', () => {
  const sandbox = { exports: {} };
  sandbox.module = { exports: sandbox.exports };
  const { createThemeBridge } = loadThemeBridge(sandbox);

  const service = makeFakeThemeService('dark');
  const bridge = createThemeBridge({
    provide: () => {
      throw new Error('not registered');
    },
    theme: service,
  });
  assert.equal(bridge.available, true, 'provide 失败必须回退到 ctx.theme');
  assert.equal(bridge.current(), 'dark');
  bridge.dispose();
});

test('主题只走已配对端口：SDK 引导与 dispatcher 都不得监听 window 的 theme 消息', () => {
  const assemblerSrc = fs.readFileSync(path.resolve(here, '../src/runtime/assembler.js'), 'utf8');
  const dispatcherSrc = fs.readFileSync(path.resolve(here, '../src/bridge/dispatcher.js'), 'utf8');

  // SDK 引导里不得出现 window 上的 theme 监听（那会被任意来源伪造）
  assert.ok(
    !/addEventListener\('message'[\s\S]{0,200}theme/.test(assemblerSrc),
    'SDK 引导不得为 theme 监听 window message（必须只走已配对端口）',
  );
  // 主题分发必须出现在 onPortMessage（配对端口）内
  assert.match(assemblerSrc, /if \(data\.kind === 'host\.push'\)/, '必须按协议 host.push 信封分发主题');
  // SDK 必须对外暴露 theme API（get/subscribe）
  assert.match(assemblerSrc, /theme:\s*\{/, 'SDK 必须暴露 theme API');
  assert.match(assemblerSrc, /get:\s*function\(\)\s*\{\s*return currentTheme;/, 'theme.get 必须返回当前主题');
  assert.match(assemblerSrc, /subscribe:\s*function\(listener\)/, 'theme.subscribe 必须可订阅变化');

  // dispatcher 必须只经 boundPort 下发
  assert.match(dispatcherSrc, /boundPort\.postMessage\(\{[\s\S]{0,160}kind: 'host\.push'/, 'dispatcher 必须经 boundPort 下发 host.push 主题信封');
  assert.ok(
    !/window\.addEventListener\(['"]message['"][\s\S]{0,200}theme/.test(dispatcherSrc),
    'dispatcher 不得监听 window 的 theme 消息',
  );
});

test('dispatcher.sendTheme：值非法或端口未绑定时必须拒绝下发', () => {
  const dispatcherSrc = fs.readFileSync(path.resolve(here, '../src/bridge/dispatcher.js'), 'utf8');
  const cjs = dispatcherSrc
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/@type\s*\{[^}]*\}/g, '')
    .replace(/@param\s*\{[^}]*\}/g, '')
    .replace(/@returns?\s*\{[^}]*\}/g, '')
    .replace(/@typedef[\s\S]*?\n\s*\*\//g, '')
    .replace(/import\s*\{([^}]*)\}\s*from\s*'([^']+)';?/g, (_m, names) => {
      const jsNames = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'))
        .join(', ');
      return `const {${jsNames}} = __deps.hostBridge;`;
    })
    .replace(/import\s*\{([^}]*)\}\s*from\s*'([^']+)';?/g, (_m, names, from) => {
      const mod = from.replace(/^\.\//, '').replace(/\.js$/, '');
      const jsNames = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'))
        .join(', ');
      return `const {${jsNames}} = __deps['${mod}'];`;
    })
    .replace(/export function (\w+)/g, 'exports.$1 = function $1');

  /** @type {any[]} */
  const posted = [];
  const deps = {
    hostBridge: {
      BRIDGE_METHODS: ['ai.generate'],
      BRIDGE_MAX_MESSAGE_BYTES: 262144,
      createRateLimiter: () => ({ tryAcquire: () => true, reset: () => {}, size: () => 0 }),
      parseInbound: () => ({ ok: true, requestId: 'r', method: 'ai.generate', payload: {} }),
      outboundOk: (id, payload) => ({ ok: true, requestId: id, payload }),
      outboundError: (id, error) => ({ ok: false, requestId: id, error }),
    },
    lease: {
      admitBridgeCall: () => ({ ok: true }),
      openInput: () => {},
      requestPause: () => null,
      completePause: () => ({ ok: true }),
    },
    sdk: { createGameCenterSDK: () => ({}) },
  };

  const sandbox = { __deps: deps, exports: {} };
  sandbox.module = { exports: sandbox.exports };
  vm.runInNewContext(cjs, sandbox);

  const d = sandbox.exports.createBridgeDispatcher({
    lease: {
      gameId: 'g', saveId: 's', runtimeInstanceId: 'rt', nonce: 'n', generation: 1,
      state: 'running', sealed: false, portBound: false, inflight: new Set(),
    },
  });

  // 未绑端口 → 必须拒绝
  assert.equal(d.sendTheme('dark'), false, '端口未绑定时不得下发');
  // 非法值 → 必须拒绝
  const port = { postMessage: (/** @type {any} */ m) => posted.push(m), onmessage: null };
  d.bindPort(port);
  // @ts-expect-error 故意传非法值
  assert.equal(d.sendTheme('purple'), false, '非法 mode 必须拒绝');
  // @ts-expect-error 故意传非法 source
  assert.equal(d.sendTheme('dark', 'martian'), false, '非法 source 必须拒绝');
  assert.equal(posted.length, 0, '非法值不得产生任何消息');

  // 合法值 → 必须经端口下发协议 host.push 信封
  assert.equal(d.sendTheme('dark'), true, '合法值必须下发');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, 'host.push');
  assert.equal(posted[0].event, 'theme');
  assert.equal(posted[0].payload.mode, 'dark');
  assert.equal(posted[0].payload.source, 'dsh', '默认来源为 DSH 显式主题');
  assert.equal(typeof posted[0].seq, 'number', '必须带单增 seq');
  assert.ok(Number.isSafeInteger(posted[0].seq) && posted[0].seq > 0, 'seq 必须是正安全整数');

  // seq 必须单增
  assert.equal(d.sendTheme('light'), true);
  assert.equal(posted.length, 2);
  assert.ok(posted[1].seq > posted[0].seq, 'seq 必须严格单增');
  assert.equal(posted[1].payload.mode, 'light');

  // source='os'（宿主跟随系统偏好时）
  assert.equal(d.sendTheme('dark', 'os'), true);
  assert.equal(posted[2].payload.source, 'os');

  // 旧格式必须彻底移除（不得再有 theme:change）
  assert.ok(!dispatcherSrc.includes("theme:change"), 'dispatcher 不得再使用旧 theme:change 格式');
  const assemblerSrc2 = fs.readFileSync(path.resolve(here, '../src/runtime/assembler.js'), 'utf8');
  assert.ok(!assemblerSrc2.includes("theme:change"), 'SDK 引导不得再使用旧 theme:change 格式');
});

test('主题推送负例：非法 mode/source、缺 seq、乱序重复一律拒绝', () => {
  const assemblerSrc = fs.readFileSync(path.resolve(here, '../src/runtime/assembler.js'), 'utf8');
  // SDK 引导对 host.push 的校验必须是"形状 + seq 单增"双重
  assert.match(assemblerSrc, /data\.kind === 'host\.push'/, '必须先判 kind');
  assert.match(assemblerSrc, /data\.event !== 'theme'/, '必须判 event');
  assert.match(assemblerSrc, /typeof data\.seq !== 'number' \|\| !Number\.isSafeInteger\(data\.seq\)/, '必须校验 seq 是安全整数');
  assert.match(assemblerSrc, /data\.seq <= lastThemeSeq/, '必须丢弃乱序/重复 seq');
  assert.match(assemblerSrc, /mode !== 'dark' && mode !== 'light'/, 'mode 只允许 light/dark');
  assert.match(assemblerSrc, /source !== 'dsh' && source !== 'os'/, 'source 只允许 dsh/os');
});

test('主题切换不得重挂游戏：SDK 引导不含重建/重载逻辑', () => {
  const assemblerSrc = fs.readFileSync(path.resolve(here, '../src/runtime/assembler.js'), 'utf8');
  // theme 分支只能是纯通知，不得触碰 location/reload/重新创建 SDK
  const themeBlock = assemblerSrc.slice(
    assemblerSrc.indexOf("if (data.kind === 'host.push')"),
    assemblerSrc.indexOf("if (typeof data.requestId === 'string')"),
  );
  assert.ok(themeBlock.length > 0, '必须存在 theme 分支');
  assert.ok(!/location\.reload|location\.href/.test(themeBlock), '主题切换不得重载页面');
  assert.ok(!/__DSH_GAMECENTER_SDK__\s*=/.test(themeBlock), '主题切换不得重建 SDK 实例');
});
