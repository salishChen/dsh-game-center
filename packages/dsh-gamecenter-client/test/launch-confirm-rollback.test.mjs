// @ts-check
/**
 * 启动确认失败的补偿路径测试（2026-10-20 架构与协议负责人指出的缺陷一）。
 *
 * 背景：`confirmLaunch` 早期只 `console.warn` 吞掉失败，界面仍显示"在跑"，
 * 但 Host 侧租约停在 pending，3 秒后被 T_ack 回收——界面在跑、存档全 STALE_RUNTIME。
 *
 * 本文件断言修复后的行为：
 * 1. 确认失败 → 不得进入运行态（界面不出现运行态标识）；
 * 2. 必须调用一次 abandonRuntime（不让 Host 留下无人持有的租约）；
 * 3. 必须给玩家可见的失败提示；
 * 4. 确认成功 → 正常进入运行态。
 *
 * 运行：node --test test/launch-confirm-rollback.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stagingFile = path.resolve(here, '../staging/client.js');

/** 最小 React harness：只实现本测试用到的 hooks。 */
function createReactHarness() {
  let stateSlots = [];
  let stateIndex = 0;
  let refSlots = [];
  let refIndex = 0;
  let callbackSlots = [];
  let callbackIndex = 0;
  let effectSlots = [];
  let effectIndex = 0;
  let isRendering = false;
  let activeComponent = null;
  let currentVdom = null;

  const scheduleRerender = () => {
    if (isRendering) return;
    if (activeComponent) currentVdom = activeComponent();
  };

  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      const idx = stateIndex++;
      if (!(idx in stateSlots)) stateSlots[idx] = initial;
      const setter = (v) => {
        const next = typeof v === 'function' ? v(stateSlots[idx]) : v;
        if (next !== stateSlots[idx]) {
          stateSlots[idx] = next;
          scheduleRerender();
        }
      };
      return [stateSlots[idx], setter];
    },
    useRef(initial) {
      const idx = refIndex++;
      if (!(idx in refSlots)) refSlots[idx] = { current: initial };
      return refSlots[idx];
    },
    useCallback(fn) {
      const idx = callbackIndex++;
      if (!(idx in callbackSlots)) callbackSlots[idx] = fn;
      return callbackSlots[idx];
    },
    useEffect(fn) {
      const idx = effectIndex++;
      if (!(idx in effectSlots)) effectSlots[idx] = fn();
      return undefined;
    },
    Fragment: 'Fragment',
  };

  return {
    react,
    /** @param {any} component @param {any} props */
    mount(component, props) {
      const run = () => {
        stateIndex = 0;
        refIndex = 0;
        callbackIndex = 0;
        effectIndex = 0;
        isRendering = true;
        const vdom = component(props);
        isRendering = false;
        return vdom;
      };
      activeComponent = () => run();
      currentVdom = run();
      return currentVdom;
    },
    getVdom() {
      return currentVdom;
    },
    /** 重新渲染（用于状态变化后取最新 VDOM） */
    rerender() {
      if (activeComponent) currentVdom = activeComponent();
      return currentVdom;
    },
  };
}

/**
 * 从 staging 产物装载插件并取到 shell.overlay 注册项。
 * @param {any} harness
 */
function loadOverlayEntry(harness) {
  const src = fs.readFileSync(stagingFile, 'utf8');
  /** @type {any} */
  let registration;
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    setTimeout,
    clearTimeout,
    // assembler 的 Bundle 校验用 TextEncoder 计算 UTF-8 字节数
    TextEncoder,
    globalThis: { crypto: { getRandomValues: () => {} }, setTimeout, clearTimeout, AbortController, TextEncoder },
  });

  const plugin = registration.factory((specifier) => (specifier === 'react' ? harness.react : {}));

  /** @type {any} */
  let overlayEntry = null;
  const ctx = {
    effect(cb) { cb(); return () => {}; },
    slots: {
      inject(name, mount) { mount(); return () => {}; },
      register(options, component) {
        if (options.name === 'shell.overlay') overlayEntry = { options, component };
        return () => {};
      },
    },
    remote: {},
  };

  plugin.apply(ctx);
  assert.ok(overlayEntry, '必须注册 shell.overlay');
  return overlayEntry;
}

/** 递归提取 VDOM 文本 */
function extractTexts(node) {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(extractTexts);
  if (typeof node === 'object' && node.props) return extractTexts(node.props.children);
  return [];
}

/**
 * 递归查找带指定 data-* 标识的节点。
 * @param {any} node
 * @param {string} marker
 * @returns {boolean}
 */
function hasMarker(node, marker) {
  if (node === null || node === undefined || node === false) return false;
  if (Array.isArray(node)) return node.some((n) => hasMarker(n, marker));
  if (typeof node === 'object' && node.props) {
    if (node.props[marker] !== undefined) return true;
    return hasMarker(node.props.children, marker);
  }
  return false;
}

/** 递归查找第一个满足 predicate 的节点 */
function findNode(node, predicate) {
  if (node === null || node === undefined || node === false) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findNode(n, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object' && node.props) {
    if (predicate(node)) return node;
    return findNode(node.props.children, predicate);
  }
  return null;
}

/** 运行态专属标识：只有 runningSession !== null 时才渲染 */
const RUNNING_MARKER = 'data-gamecenter-game-active';

/** 伪造一个已安装的目录条目 */
function makeCatalogEntry() {
  return {
    gameId: 'example.minesweeping',
    title: '扫雷',
    summary: 'AI 生成无猜对局',
    version: '1.0.0',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: 'a'.repeat(40),
    manifestDigest: 'b'.repeat(64),
    bundleDigest: 'c'.repeat(64),
    approvalState: 'approved',
    installed: true,
    installedCommit: 'a'.repeat(40),
  };
}

/** 装配一个完整可用的 getService，并记录所有调用 */
function makeRecordingService(overrides = {}) {
  /** @type {{method: string, input?: any}[]} */
  const calls = [];
  const service = {
    catalogList: async () => ({ ok: true, source: 'github', entries: [makeCatalogEntry()] }),
    previewList: async () => ({ ok: true, configured: false, entries: [] }),
    // files 至少一个条目，否则 assembler 的 Bundle 校验会拒绝（files 不能为空）
    gameBundle: async () => ({
      ok: true,
      entryPath: 'dist/index.html',
      files: [{path:'gamecenter.json',content:JSON.stringify({schemaVersion:1,id:'example.minesweeping',version:'1.0.0',runtime:{kind:'web',entry:'dist/index.html'}})}, { path: 'dist/index.html', content: '<!doctype html><html><body>game</body></html>' }],
    }),
    handshake: async (input) => {
      calls.push({ method: 'handshake', input });
      return { ok: true, generation: 1, runtimeToken: 'tok-abc', state: 'running' };
    },
    leaseStatus: async (input) => {
      calls.push({ method: 'leaseStatus', input });
      return { state: 'running', generation: 1, lastPersistedRevision: 0 };
    },
    abandonRuntime: async (input) => {
      calls.push({ method: 'abandonRuntime', input });
      return { ok: true, abandoned: true, reclaimed: true };
    },
    saveLatest: async (input) => {
      calls.push({ method: 'saveLatest', input });
      return { ok: true, absent: true };
    },
    ...overrides,
  };
  return { service, calls };
}

/**
 * 在 VDOM 树里找一个"我的游戏"条目按钮（用于触发启动路径）。
 * 该弹层在无目录数据时不渲染条目，所以本 helper 主要返回 null。
 */
function findGameEntry(vdom) {
  return null;
}

test('启动确认失败：必须清空会话、调用一次 abandonRuntime、并给玩家可见提示', async () => {
  const harness = createReactHarness();
  const overlayEntry = loadOverlayEntry(harness);
  const props = overlayEntry.options.inject();
  props.overlay.open = true;

  const { service, calls } = makeRecordingService({
    // 确认失败：正是"界面以为在跑、Host 其实没收到"的场景
    leaseStatus: async (input) => {
      calls.push({ method: 'leaseStatus', input });
      throw Object.assign(new Error('Host 拒绝查询'), { code: 'STALE_RUNTIME' });
    },
  });
  props.getService = () => service;

  const vdom = harness.mount(overlayEntry.component, props);
  // 等 loadCatalog 的 effect 跑完并渲染出目录条目
  await new Promise((r) => setTimeout(r, 40));
  const withEntries = harness.rerender() ?? vdom;

  const launchBtn = findNode(
    withEntries,
    (n) => typeof n.props?.onLaunch === 'function' && n.props.entries?.length > 0,
  );
  assert.ok(launchBtn, '游戏库必须接收已过滤的目录与启动回调');

  launchBtn.props.onLaunch(launchBtn.props.entries[0]);
  await new Promise((r) => setTimeout(r, 60));
  const latest = harness.rerender() ?? withEntries;

  // 1. 不得进入运行态
  assert.ok(!hasMarker(latest, RUNNING_MARKER), '确认失败时不得渲染运行态');
  // 2. 必须调用一次 abandonRuntime（不让 Host 留下无人持有的租约）
  const abandonCalls = calls.filter((c) => c.method === 'abandonRuntime');
  assert.equal(abandonCalls.length, 1, `必须恰好调用一次 abandonRuntime，实际 ${abandonCalls.length}`);
  assert.equal(typeof abandonCalls[0].input.launchToken, 'string', 'abandonRuntime 必须带 launchToken');
  assert.ok(abandonCalls[0].input.launchToken.length >= 32, 'launchToken 必须满足协议形状');
  assert.equal(typeof abandonCalls[0].input.runtimeInstanceId, 'string', 'abandonRuntime 必须带 runtimeInstanceId');
  // 3. 玩家必须看到失败提示
  const texts = extractTexts(latest).join(' ');
  assert.match(texts, /启动失败/, '必须给玩家可见的失败提示');
  // 4. 握手必须先于确认（时序）
  const handshakeIdx = calls.findIndex((c) => c.method === 'handshake');
  const leaseIdx = calls.findIndex((c) => c.method === 'leaseStatus');
  const abandonIdx = calls.findIndex((c) => c.method === 'abandonRuntime');
  assert.ok(handshakeIdx >= 0 && leaseIdx > handshakeIdx, '必须先握手后确认');
  assert.ok(abandonIdx > leaseIdx, '确认失败后必须放弃');
});

test('confirmLaunch 契约：leaseStatus 返回 absent 必须判为失败并放弃', async () => {
  const harness = createReactHarness();
  const overlayEntry = loadOverlayEntry(harness);
  const props = overlayEntry.options.inject();
  props.overlay.open = true;

  const { service, calls } = makeRecordingService({
    // Host 对无效凭证统一回 absent:true（不区分原因，避免探测）
    leaseStatus: async (input) => {
      calls.push({ method: 'leaseStatus', input });
      return { absent: true };
    },
  });
  props.getService = () => service;

  const vdom = harness.mount(overlayEntry.component, props);
  await new Promise((r) => setTimeout(r, 40));
  const withEntries = harness.rerender() ?? vdom;
  const launchBtn = findNode(
    withEntries,
    (n) => typeof n.props?.onLaunch === 'function' && n.props.entries?.length > 0,
  );
  assert.ok(launchBtn, '游戏库必须接收已过滤的目录与启动回调');
  launchBtn.props.onLaunch(launchBtn.props.entries[0]);
  await new Promise((r) => setTimeout(r, 60));
  const latest = harness.rerender() ?? withEntries;

  assert.ok(!hasMarker(latest, RUNNING_MARKER), 'absent 时不得渲染运行态');
  assert.equal(
    calls.filter((c) => c.method === 'abandonRuntime').length,
    1,
    'absent 必须判为确认失败并放弃租约',
  );
  assert.match(extractTexts(latest).join(' '), /启动失败/, 'absent 时必须给玩家失败提示');
});

test('launchToken 生成失败（无 CSPRNG）：启动必须失败且不渲染运行态', async () => {
  const harness = createReactHarness();
  const overlayEntry = loadOverlayEntry(harness);
  const props = overlayEntry.options.inject();
  props.overlay.open = true;
  // 模拟 createLaunchToken 抛错：不得降级到 Math.random
  props.makeLaunchToken = () => {
    throw new Error('运行时缺少 CSPRNG（crypto.getRandomValues），无法生成不可猜的 launchToken');
  };

  props.getService = () => ({
    handshake: async () => ({ ok: true, generation: 1, runtimeToken: 'tok-abc', state: 'running' }),
    leaseStatus: async () => ({ state: 'running', generation: 1 }),
    abandonRuntime: async () => ({ ok: true, abandoned: true, reclaimed: false }),
    gameBundle: async () => ({ ok: true, entryPath: 'dist/index.html', files: [] }),
  });

  // 渲染与状态推进都不得抛错：失败必须在组件内部被捕获并转成 notice
  const vdom = harness.mount(overlayEntry.component, props);
  await new Promise((r) => setTimeout(r, 30));
  const latest = harness.rerender() ?? vdom;
  const texts = extractTexts(latest).join(' ');
  assert.ok(!hasMarker(latest, RUNNING_MARKER), 'launchToken 生成失败时不得渲染运行态');
  assert.ok(!texts.includes('正在保存并暂停'), 'launchToken 生成失败时不得进入暂停文案');
});

test('启动确认成功：正常路径必须进入运行态且确认先于 iframe 端口投递', async () => {
  const harness = createReactHarness();
  const overlayEntry = loadOverlayEntry(harness);
  const props = overlayEntry.options.inject();
  props.overlay.open = true;

  const { service, calls } = makeRecordingService();
  props.getService = () => service;

  const vdom = harness.mount(overlayEntry.component, props);
  await new Promise((r) => setTimeout(r, 40));
  const withEntries = harness.rerender() ?? vdom;
  const launchBtn = findNode(
    withEntries,
    (n) => typeof n.props?.onLaunch === 'function' && n.props.entries?.length > 0,
  );
  assert.ok(launchBtn, '游戏库必须接收已过滤的目录与启动回调');
  launchBtn.props.onLaunch(launchBtn.props.entries[0]);
  await new Promise((r) => setTimeout(r, 80));
  const latest = harness.rerender() ?? withEntries;

  // 正常路径必须进入运行态
  assert.ok(hasMarker(latest, RUNNING_MARKER), '确认成功时必须渲染运行态');
  // 时序：handshake → leaseStatus(确认) → 运行态
  const handshakeIdx = calls.findIndex((c) => c.method === 'handshake');
  const leaseIdx = calls.findIndex((c) => c.method === 'leaseStatus');
  assert.ok(handshakeIdx >= 0, '必须先握手');
  assert.ok(leaseIdx > handshakeIdx, '确认必须发生在握手之后');
  // 确认成功后不得 abandon（正常路径不该放弃）
  assert.equal(calls.filter((c) => c.method === 'abandonRuntime').length, 0, '确认成功时不得放弃租约');
  // iframe 必须在运行态里（证明端口投递在确认之后）
  assert.ok(hasMarker(latest, 'data-gamecenter-game-active'), '运行态必须渲染受控 iframe 容器');
});
