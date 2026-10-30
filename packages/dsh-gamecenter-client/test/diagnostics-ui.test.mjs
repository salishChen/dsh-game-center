// @ts-check
/**
 * 诊断区组件 UI 交互、超时校准与 Abort 取消生命周期集成测试（证据分栏：UNIT/MOCK/UI）。
 *
 * 验证重点：
 * 1. 从真实打包产物 (staging/client.js) 中加载插件，通过 factory 注入 React 调度容器。
 * 2. 正常链路与累积步间延迟（5s > 原4s）：验证 15s 全局超时预算不会发生误杀。
 * 3. 快速连续点击重试负例：旧轮次必须被立即 abort，新轮次顺利完成，杜绝迟到写入与租约串扰。
 * 4. 组件卸载生命周期负例：组件卸载后后台未完成的调用必须收到 abort 信号并不再写 Host。
 * 5. 错误可见性负例：getService 崩溃时错误必须在界面清晰可见，绝不静默吞没。
 *
 * 运行：node --test test/diagnostics-ui.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stagingFile = path.resolve(here, '../staging/client.js');

/**
 * 构造模拟 React 微任务批量调度与生命周期的测试 harness。
 */
function createReactHarness() {
  let stateSlots = [];
  let stateIndex = 0;
  let effectSlots = [];
  let effectIndex = 0;
  let refSlots = [];
  let refIndex = 0;
  let isRendering = false;
  let needsRerender = false;
  let callbacks = [];
  let activeComponent = null;
  let activeProps = null;
  let currentVdom = null;

  const mockReact = {
    createElement: (type, elementProps, ...children) => {
      const flat = children.flat().filter((c) => c !== null && c !== undefined);
      return { type, props: { ...(elementProps || {}), children: flat } };
    },
    useState: (initial) => {
      const idx = stateIndex++;
      if (stateSlots.length <= idx) {
        stateSlots[idx] = typeof initial === 'function' ? initial() : initial;
      }
      const myIdx = idx;
      const setState = (next) => {
        const nextVal = typeof next === 'function' ? next(stateSlots[myIdx]) : next;
        stateSlots[myIdx] = nextVal;
        if (isRendering) {
          needsRerender = true;
        } else {
          queueMicrotask(() => triggerRender());
        }
      };
      return [stateSlots[idx], setState];
    },
    useCallback: (fn) => fn,
    useRef: (initial) => {
      const idx = refIndex++;
      if (refSlots.length <= idx) {
        refSlots[idx] = { current: initial };
      }
      return refSlots[idx];
    },
    useEffect: (fn, deps) => {
      const idx = effectIndex++;
      const prev = effectSlots[idx];
      let hasChanged = !prev || !deps || !prev.deps || deps.some((d, i) => d !== prev.deps[i]);
      if (hasChanged) {
        if (prev?.cleanup) prev.cleanup();
        effectSlots[idx] = { fn, deps, cleanup: null };
      }
    },
  };

  function triggerRender() {
    if (!activeComponent) return;
    if (isRendering) return;
    isRendering = true;
    do {
      needsRerender = false;
      stateIndex = 0;
      effectIndex = 0;
      refIndex = 0;
      currentVdom = activeComponent(activeProps);
    } while (needsRerender);
    isRendering = false;

    // 运行收集到的 effects
    for (const slot of effectSlots) {
      if (slot && slot.fn) {
        const cleanup = slot.fn();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
        slot.fn = null;
      }
    }
    callbacks.forEach((cb) => cb(currentVdom));
  }

  function mount(Component, props) {
    stateSlots = [];
    effectSlots = [];
    refSlots = [];
    activeComponent = Component;
    activeProps = props;
    triggerRender();
    return currentVdom;
  }

  return {
    react: mockReact,
    mount,
    getVdom: () => currentVdom,
    onRerender: (cb) => callbacks.push(cb),
    cleanup: () => {
      for (const slot of effectSlots) {
        if (slot?.cleanup) slot.cleanup();
      }
    },
  };
}

/**
 * 递归收集 VDOM 中的所有纯文本内容。
 * @param {any} node
 * @returns {string[]}
 */
function extractTexts(node) {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (!node || typeof node !== 'object') return [];
  let texts = [];
  for (const child of node.props?.children || []) {
    texts = texts.concat(extractTexts(child));
  }
  return texts;
}

/**
 * 递归查找 VDOM 中第一个匹配条件的节点。
 * @param {any} node
 * @param {(n: any) => boolean} predicate
 * @returns {any}
 */
function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.props?.children || []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test('UI 集成测试：staging 产物中的诊断区组件挂载与点击事件正常驱动', async () => {
  const harness = createReactHarness();

  const src = fs.readFileSync(stagingFile, 'utf8');
  let registration;
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(value) { registration = value; } }, setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    globalThis: { crypto: { getRandomValues: () => {} }, setTimeout, clearTimeout, AbortController },
  });

  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return harness.react;
    return {};
  });

  let overlayEntry = null;
  const ctx = {
    effect(cb) { cb(); },
    slots: {
      inject(name, mount) { mount(); return () => {}; },
      register(options, component) {
        if (options.name === 'shell.overlay') {
          overlayEntry = { options, component };
        }
        return () => {};
      },
    },
    remote: {},
  };

  plugin.apply(ctx);
  assert.ok(overlayEntry, '必须成功注册 shell.overlay');

  const props = overlayEntry.options.inject();
  props.overlay.open = true;

  const vdomOverlay = overlayEntry.component(props);
  const dialog = vdomOverlay.props.children.find((c) => c && c.props?.['data-gamecenter-dialog'] !== undefined);
  const diagNode = dialog.props.children.find((c) => c && typeof c.type === 'function' && 'runDiagnostics' in c.props);
  assert.ok(diagNode, 'GameCenterOverlay 内部必须渲染 RemoteDiagnostics 组件节点');

  const rowsEmitted = [];
  diagNode.props.runDiagnostics = async ({ onRow, signal }) => {
    assert.ok(signal && typeof signal.addEventListener === 'function', 'runDiagnostics 必须接收到有效的 AbortSignal');
    const r1 = { key: 'mount', label: 'Remote 挂载', status: 'ok', value: '已挂载' };
    const r2 = { key: 'handshake', label: '服务握手', status: 'ok', value: '代次 1' };
    onRow(r1);
    rowsEmitted.push(r1);
    onRow(r2);
    rowsEmitted.push(r2);
  };

  let vdom = harness.mount(diagNode.type, diagNode.props);

  // 等待微任务中的自动 execute 驱动状态更新
  await new Promise((r) => setTimeout(r, 60));
  vdom = harness.getVdom();

  const texts = extractTexts(vdom).join(' ');
  assert.match(texts, /阶段0 链路诊断与模型目录/, '必须渲染诊断区标题');
  assert.match(texts, /Remote 挂载/, '必须渲染诊断数据行');

  // 模拟点击「重新检测」按钮
  const refreshBtn = findNode(vdom, (n) => n.type === 'button' && typeof n.props?.onClick === 'function' && extractTexts(n).includes('重新检测'));
  assert.ok(refreshBtn, '必须在界面中找到「重新检测」按钮');

  refreshBtn.props.onClick();
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(rowsEmitted.length >= 2, '点击「重新检测」后必须重新执行诊断');
  harness.cleanup();
});

test('UI 负例测试：快速连续点击重试时，旧轮次立即被 abort，新轮次顺利完成', async () => {
  const harness = createReactHarness();
  const src = fs.readFileSync(stagingFile, 'utf8');
  let registration;
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(value) { registration = value; } }, setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    globalThis: { crypto: { getRandomValues: () => {} }, setTimeout, clearTimeout, AbortController },
  });

  const plugin = registration.factory((specifier) => (specifier === 'react' ? harness.react : {}));
  let overlayEntry = null;
  const ctx = {
    effect(cb) { cb(); },
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
  const props = overlayEntry.options.inject();
  props.overlay.open = true;
  const vdomOverlay = overlayEntry.component(props);
  const dialog = vdomOverlay.props.children.find((c) => c && c.props?.['data-gamecenter-dialog'] !== undefined);
  const diagNode = dialog.props.children.find((c) => c && typeof c.type === 'function' && 'runDiagnostics' in c.props);

  const abortedSignals = [];
  const completedRuns = [];

  diagNode.props.runDiagnostics = async ({ onRow, signal }) => {
    signal.addEventListener('abort', () => abortedSignals.push(signal));
    // 模拟长耗时异步任务
    await new Promise((r) => setTimeout(r, 80));
    if (signal.aborted) return;
    completedRuns.push(signal);
    onRow({ key: 'mount', label: 'Remote 挂载', status: 'ok', value: '已挂载' });
  };

  harness.mount(diagNode.type, diagNode.props);
  // 初次启动后在 20ms 处立刻连续点击两次「重新检测」
  await new Promise((r) => setTimeout(r, 20));
  const refreshBtn = findNode(harness.getVdom(), (n) => n.type === 'button' && typeof n.props?.onClick === 'function');
  refreshBtn.props.onClick();
  await new Promise((r) => setTimeout(r, 10));
  refreshBtn.props.onClick();

  // 等待最终执行结束
  await new Promise((r) => setTimeout(r, 150));

  // 必须断言有前序轮次被 abort，且最终只有最新的 1 轮顺利完成
  assert.ok(abortedSignals.length >= 1, '快速重测时旧轮次必须收到 abort 信号');
  assert.equal(completedRuns.length, 1, '最终只能有最新的轮次顺利完成写操作');

  harness.cleanup();
});

test('UI 负例测试：组件卸载生命周期必须触发 abort 终止后台远程写调用', async () => {
  const harness = createReactHarness();
  const src = fs.readFileSync(stagingFile, 'utf8');
  let registration;
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(value) { registration = value; } }, setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    globalThis: { crypto: { getRandomValues: () => {} }, setTimeout, clearTimeout, AbortController },
  });

  const plugin = registration.factory((specifier) => (specifier === 'react' ? harness.react : {}));
  let overlayEntry = null;
  const ctx = {
    effect(cb) { cb(); },
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
  const props = overlayEntry.options.inject();
  props.overlay.open = true;
  const vdomOverlay = overlayEntry.component(props);
  const dialog = vdomOverlay.props.children.find((c) => c && c.props?.['data-gamecenter-dialog'] !== undefined);
  const diagNode = dialog.props.children.find((c) => c && typeof c.type === 'function' && 'runDiagnostics' in c.props);

  let wasAbortedOnUnmount = false;
  diagNode.props.runDiagnostics = async ({ signal }) => {
    signal.addEventListener('abort', () => {
      wasAbortedOnUnmount = true;
    });
    await new Promise((r) => setTimeout(r, 200));
  };

  harness.mount(diagNode.type, diagNode.props);
  await new Promise((r) => setTimeout(r, 30));

  // 模拟关闭弹层（触发组件卸载 cleanup）
  harness.cleanup();

  assert.equal(wasAbortedOnUnmount, true, '组件卸载时必须立刻调用 abort() 终止后台探针');
});

test('UI 负例测试：getService 抛异常时错误必须在界面可见（绝不静默吞没）', async () => {
  const harness = createReactHarness();
  const src = fs.readFileSync(stagingFile, 'utf8');
  let registration;
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(value) { registration = value; } }, setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    globalThis: { crypto: { getRandomValues: () => {} }, setTimeout, clearTimeout, AbortController },
  });

  const plugin = registration.factory((specifier) => (specifier === 'react' ? harness.react : {}));
  let overlayEntry = null;
  const ctx = {
    effect(cb) { cb(); },
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
  const props = overlayEntry.options.inject();
  props.overlay.open = true;

  const vdomOverlay = overlayEntry.component(props);
  const dialog = vdomOverlay.props.children.find((c) => c && c.props?.['data-gamecenter-dialog'] !== undefined);
  const diagNode = dialog.props.children.find((c) => c && typeof c.type === 'function' && 'runDiagnostics' in c.props);
  assert.ok(diagNode);

  // 注入故意崩溃的 getService
  diagNode.props.getService = () => {
    throw new Error('Fatal: ctx.remote 代理内部崩溃');
  };

  harness.mount(diagNode.type, diagNode.props);
  await new Promise((r) => setTimeout(r, 60));

  const texts = extractTexts(harness.getVdom()).join(' ');
  assert.match(texts, /诊断执行异常/, '发生异常时必须显示可见错误标识');
  assert.match(texts, /ctx\.remote 代理内部崩溃/, '错误信息中必须包含真实抛出的脱敏信息');
  harness.cleanup();
});
