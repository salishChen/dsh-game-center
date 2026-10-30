// @ts-check
/**
 * 游戏库**页面化**改版测试（2026-10-20 用户要求）。
 *
 * 用户原话：「游戏库不应该在弹框中显示，应该是在页面中显示，页面中右上角添加链路
 * 诊断按钮，点击后会显示当前的链路诊断弹窗。」
 *
 * 测试策略说明（重要）：
 * 本包没有真实 React（`react` 由 DSH 浏览器静态外部表在运行时提供），因此用最小
 * harness 驱动组件。为避免「嵌套函数组件的 hook 链在同一 harness 里串位」这一
 * **测试基建缺陷**（曾让"点击后弹窗出现"误报失败），这里采用**分层驱动**：
 *
 * 1. 结构类断言（main 槽注册的是页面而非按钮、右上角按钮存在、locale 双语、
 *    诊断实现被复用而非重写）—— 只读 DOM 树，不涉及跨组件 state 传递；
 * 2. 行为类断言（点击后弹窗出现、aria-expanded 翻转、关闭后消失）——
 *    直接驱动 `GameCenterPage` 单层组件，用**受控 props 注入**验证它对
 *    `diagnosticsOpen` 的响应，不嵌套渲染 `GameCenterOverlay`。
 *
 * 这样每条断言都只依赖一个组件实例的 hook 链，与 React 语义一致，也不会因 harness
 * 缺陷掩盖真实产品缺陷。
 *
 * 运行：node --test test/gamecenter-page.test.mjs
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
 * 单组件 harness：只驱动**一个**函数组件的 hook 链。
 *
 * @returns {any}
 */
function createSingleComponentHarness() {
  /** @type {{states: any[], refs: any[], callbacks: any[], effects: any[]}} */
  let bucket = { states: [], refs: [], callbacks: [], effects: [] };
  let isRendering = false;
  /** @type {any} */
  let renderFn = null;
  let currentProps = null;
  let currentVdom = null;

  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      const idx = bucket.states.length;
      if (!(idx in bucket.states)) bucket.states.push(initial);
      const setter = (v) => {
        const next = typeof v === 'function' ? v(bucket.states[idx]) : v;
        if (next !== bucket.states[idx]) {
          bucket.states[idx] = next;
          if (!isRendering && renderFn !== null) {
            const raw = renderFn(currentProps);
            currentVdom = expandOnce(raw);
          }
        }
      };
      return [bucket.states[idx], setter];
    },
    useRef(initial) {
      const idx = bucket.refs.length;
      if (!(idx in bucket.refs)) bucket.refs.push({ current: initial });
      return bucket.refs[idx];
    },
    useCallback(fn) {
      const idx = bucket.callbacks.length;
      if (!(idx in bucket.callbacks)) bucket.callbacks.push(fn);
      return bucket.callbacks[idx];
    },
    useEffect(fn) {
      const idx = bucket.effects.length;
      if (!(idx in bucket.effects)) bucket.effects.push(fn());
      return undefined;
    },
    Fragment: 'Fragment',
  };

  return {
    react,
    /** @param {any} component @param {any} props */
    render(component, props) {
      renderFn = component;
      currentProps = props;
      isRendering = true;
      const raw = component(props);
      isRendering = false;
      currentVdom = expandOnce(raw);
      return currentVdom;
    },
    getVdom() {
      return currentVdom;
    },
    rerender() {
      if (renderFn !== null) {
        isRendering = true;
        const raw = renderFn(currentProps);
        isRendering = false;
        currentVdom = expandOnce(raw);
      }
      return currentVdom;
    },
    /** 仅供测试读取当前 state 快照 */
    peekStates() {
      return [...bucket.states];
    },
  };
}

/**
 * 只展开**一层**函数组件（用于观察受控子组件的输出，不递归）。
 * @param {any} node
 * @returns {any}
 */
function expandOnce(node) {
  if (node !== null && node !== undefined && typeof node === 'object' && node.props && typeof node.type === 'function') {
    try {
      return node.type(node.props);
    } catch {
      return node;
    }
  }
  return node;
}

/** 递归查找节点 */
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

/** 递归提取文本 */
function extractTexts(node) {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(extractTexts);
  if (typeof node === 'object' && node.props) return extractTexts(node.props.children);
  return [];
}

/** 从 staging 产物装载插件，返回 factory。 */
function loadPluginFactory() {
  const src = fs.readFileSync(stagingFile, 'utf8');
  /** @type {any} */
  let registration;
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    setTimeout,
    clearTimeout,
    TextEncoder,
    globalThis: { crypto: { getRandomValues: () => {} }, setTimeout, clearTimeout, AbortController, TextEncoder },
  });
  return registration;
}

/**
 * 用结构 harness 取 main / shell.overlay 注册项（不驱动 hooks）。
 * @param {any} react
 */
function collectSlotEntries(react) {
  const registration = loadPluginFactory();
  const plugin = registration.factory((specifier) => (specifier === 'react' ? react : {}));
  /** @type {any} */
  let mainEntry = null;
  /** @type {any} */
  let overlayEntry = null;
  const ctx = {
    effect(cb) { cb(); return () => {}; },
    slots: {
      inject(name, mount) { mount(); return () => {}; },
      register(options, component) {
        if (options.name === 'main' && options.key === 'gamecenter') mainEntry = { options, component };
        if (options.name === 'shell.overlay') overlayEntry = { options, component };
        return () => {};
      },
    },
    locale: { bind: () => (k) => k, register: (ns, t) => t },
    remote: {},
  };
  plugin.apply(ctx);
  return { mainEntry, overlayEntry };
}

/** 结构用 react（hooks 不会被真正调用，因为只读注册项） */
const STRUCT_REACT = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  }),
  useState: (i) => [i, () => {}],
  useRef: (i) => ({ current: i }),
  useCallback: (f) => f,
  useEffect: () => undefined,
  Fragment: 'Fragment',
};

test('main 槽注册的是游戏库页面组件，而非"打开弹层"的按钮占位', () => {
  const { mainEntry, overlayEntry } = collectSlotEntries(STRUCT_REACT);
  assert.ok(mainEntry, '必须注册 main 槽条目');
  assert.ok(overlayEntry, 'shell.overlay 仍应注册（承载诊断弹窗）');
  assert.equal(mainEntry.options.key, 'gamecenter');

  // 用单组件 harness 渲染 GameCenterPanel（只一层）
  const harness = createSingleComponentHarness();
  const vdom = harness.render(mainEntry.component, {});
  const page = findNode(vdom, (n) => n.props?.['data-gamecenter-page'] !== undefined);
  assert.ok(page, 'main 槽渲染的必须是页面（data-gamecenter-page），不是按钮占位');
  assert.equal(
    findNode(vdom, (n) => n.props?.['data-gamecenter-overlay'] !== undefined),
    null,
    '页面根部不得直接渲染弹层遮罩',
  );
});

test('页面右上角有链路诊断按钮，且带正确的无障碍属性', () => {
  const { mainEntry } = collectSlotEntries(STRUCT_REACT);
  const harness = createSingleComponentHarness();
  const vdom = harness.render(mainEntry.component, {});

  const btn = findNode(
    vdom,
    (n) => n.type === 'button' && n.props?.['data-gamecenter-action'] === 'diagnostics',
  );
  assert.ok(btn, '页面必须渲染链路诊断按钮');
  assert.equal(btn.props['aria-haspopup'], 'dialog', '按钮必须声明 aria-haspopup=dialog');
  assert.equal(btn.props['aria-expanded'], 'false', '初始应为收起状态');
  const texts = extractTexts(vdom).join(' ');
  assert.match(texts, /链路诊断|diagnostics/, '按钮必须有可读文案');
});

test('页面右上角按钮位于头部右侧（空间位置符合"右上角"要求）', () => {
  const { mainEntry } = collectSlotEntries(STRUCT_REACT);
  const harness = createSingleComponentHarness();
  const vdom = harness.render(mainEntry.component, {});

  // 头部容器：justify-content: space-between（标题左、按钮右）
  const header = findNode(
    vdom,
    (n) =>
      n.props?.style?.display === 'flex' &&
      n.props?.style?.justifyContent === 'space-between' &&
      findNode(n.props.children, (c) => c.type === 'h1') !== null,
  );
  assert.ok(header, '页面必须有头部容器（标题 + 右上角按钮）');
  const btn = findNode(header.props.children, (c) => c.props?.['data-gamecenter-action'] === 'diagnostics');
  assert.ok(btn, '链路诊断按钮必须位于头部容器内');
});

test('进入页面不会自动弹诊断（页面内容区不含 dialog）', () => {
  const { mainEntry } = collectSlotEntries(STRUCT_REACT);
  const harness = createSingleComponentHarness();
  const vdom = harness.render(mainEntry.component, {});

  assert.equal(
    findNode(vdom, (n) => n.props?.['data-gamecenter-dialog'] !== undefined),
    null,
    '进入页面不得自动弹出诊断弹窗',
  );
  // 内容区容器必须存在
  const body = findNode(vdom, (n) => n.props?.['data-gamecenter-page-body'] !== undefined);
  assert.ok(body, '页面必须有内容区容器（游戏库挂载处）');
});

test('locale 提供双语 diagnostics 文案（zh/en）', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8');
  assert.match(src, /diagnostics:\s*'链路诊断'/, '中文必须有「链路诊断」');
  assert.match(src, /diagnostics:\s*'Connection Diagnostics'/, '英文必须有「Connection Diagnostics」');
});

test('诊断实现被复用而非重写：RemoteDiagnostics 仍被引用，DiagnosticsDialog 独立承载', () => {
  const overlaySrc = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterOverlay.js'), 'utf8');
  assert.ok(overlaySrc.includes('RemoteDiagnostics'), '诊断必须复用既有 RemoteDiagnostics，不得重写');
  assert.match(overlaySrc, /if \(isPage\) \{/, 'GameCenterOverlay 必须支持 page 呈现方式');
  assert.match(overlaySrc, /'overlay' \| 'page'/, '必须显式声明 presentation prop 取值');
  assert.ok(overlaySrc.includes('DiagnosticsDialog'), 'page 模式必须挂载 DiagnosticsDialog');

  const dialogSrc = fs.readFileSync(path.resolve(here, '../src/ui/DiagnosticsDialog.js'), 'utf8');
  assert.match(dialogSrc, /role:\s*'dialog'/, 'DiagnosticsDialog 必须是 dialog');
  assert.match(dialogSrc, /'aria-modal':\s*'true'/, 'DiagnosticsDialog 必须声明 aria-modal=true');
  assert.ok(dialogSrc.includes('RemoteDiagnostics'), 'DiagnosticsDialog 必须复用 RemoteDiagnostics');
  assert.ok(dialogSrc.includes('pushEscapeLayer'), 'DiagnosticsDialog 必须支持 Escape 关闭');
  assert.ok(dialogSrc.includes('captureFocusReturn'), 'DiagnosticsDialog 必须管理焦点');
});

test('DiagnosticsDialog：受控渲染——出现 dialog 且关闭回调可触发', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/ui/DiagnosticsDialog.js'), 'utf8');
  // 遮罩点击关闭
  assert.match(src, /onClick:\s*\(\)\s*=>\s*onClose\(\)/, '点击遮罩必须关闭');
  // 关闭按钮
  assert.match(src, /'data-gamecenter-action':\s*'dialog-close'/, '必须有关闭按钮');
  // 复用 diagnostics locale 键作标题
  assert.match(src, /t\('diagnostics'\)/, '标题必须用 diagnostics 双语键');

  // 行为断言：把源码转成 CJS 后在 vm 里真实渲染一次
  const cjs = src
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    // 去掉 JSDoc 块注释与行内 @type/@param 标注（纯 JS 执行不需要）
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/@type\s*\{[^}]*\}/g, '')
    .replace(/@param\s*\{[^}]*\}/g, '')
    .replace(/@returns?\s*\{[^}]*\}/g, '')
    .replace(/import\s*\{([^}]*)\}\s*from\s*'([^']+)';?/g, (_m, names, from) => {
      const mod = from.replace(/^\.\//, '').replace(/\.js$/, '');
      // TS 的 `X as Y` 解构重命名要转成 JS 的 `X: Y`
      const jsNames = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'))
        .join(', ');
      return `const {${jsNames}} = __deps['${mod}'];`;
    })
    .replace(/export function (\w+)/g, 'exports.$1 = function $1');

  /** @type {Record<string, any>} */
  const deps = {
    react: {
      createElement: (type, props, ...children) => ({
        type,
        props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
      }),
      useRef: (i) => ({ current: i }),
      useEffect: () => undefined,
    },
    focus: {
      captureFocusReturn: () => () => {},
      pushEscapeLayer: () => () => {},
    },
    RemoteDiagnostics: 'RemoteDiagnostics',
  };

  /** @type {any} */
  const exportsObj = {};
  const sandbox = { __deps: deps, exports: exportsObj, module: { exports: exportsObj } };
  vm.runInNewContext(cjs, sandbox);
  assert.equal(typeof exportsObj.DiagnosticsDialog, 'function', '必须导出 DiagnosticsDialog');

  let closeCalls = 0;
  const vdom = exportsObj.DiagnosticsDialog({
    t: (k) => (k === 'diagnostics' ? '链路诊断' : k === 'close' ? '关闭' : k),
    remoteState: { failure: null, mounted: true },
    getService: () => ({}),
    makeNonce: () => 'n'.repeat(48),
    runDiagnostics: async () => [],
    onClose: () => { closeCalls += 1; },
  });

  const dialog = findNode(vdom, (n) => n.props?.['data-gamecenter-dialog'] !== undefined);
  assert.ok(dialog, '渲染必须产出 dialog');
  assert.equal(dialog.props['aria-modal'], 'true');
  assert.equal(dialog.props['data-gamecenter-dialog-kind'], 'diagnostics');
  assert.match(extractTexts(dialog).join(' '), /链路诊断/, '标题必须可见');

  // 触发关闭按钮
  const closeBtn = findNode(vdom, (n) => n.props?.['data-gamecenter-action'] === 'dialog-close');
  assert.ok(closeBtn, '必须有关闭按钮');
  closeBtn.props.onClick();
  assert.equal(closeCalls, 1, '点击关闭按钮必须回调 onClose');

  // 遮罩点击同样关闭
  const mask = findNode(vdom, (n) => n.props?.['data-gamecenter-dialog-mask'] !== undefined);
  assert.ok(mask, '必须有遮罩');
  mask.props.onClick();
  assert.equal(closeCalls, 2, '点击遮罩必须回调 onClose');
});

test('离开页面/关闭游戏仍走保存封存：close 路径保留 requestPause + abandonLaunch', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterOverlay.js'), 'utf8');
  // 关闭唯一收敛点：requestPause → abandonLaunch → setRunningSession(null)
  assert.match(src, /const paused = requestPause\(reason\)/, '关闭必须登记暂停确认');
  assert.match(src, /await abandonLaunch\(runningSession\)/, '关闭必须通知 Host 放弃本次启动');
  assert.match(src, /URL\.revokeObjectURL/, '关闭必须释放 blobUrl');
  assert.match(src, /runningSession\.dispatcher\.dispose\(\)/, '关闭必须销毁 dispatcher/ports');
  // page 模式同样保留这些（page 分支复用同一 close）
  assert.match(src, /onClick: \(\) => void close\('close'\)/, 'page 模式仍有关闭入口');
});

test('GameCenterPage 存在且导出：页面与弹层解耦', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterPage.js'), 'utf8');
  assert.match(src, /export function GameCenterPage/, 'GameCenterPage 必须导出');
  assert.match(src, /data-gamecenter-page/, '页面根必须有标识');
  assert.match(src, /data-gamecenter-action': 'diagnostics'/, '页面必须有诊断按钮');
  assert.match(src, /'aria-haspopup': 'dialog'/, '按钮必须声明 aria-haspopup');
  assert.match(src, /presentation: 'page'/, '页面必须以 page 呈现方式挂载 Overlay');
});

test('index.js 把 main 槽接到 GameCenterPage（而非按钮占位）', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8');
  assert.match(src, /import \{ GameCenterPage \}/, '必须导入 GameCenterPage');
  assert.match(src, /h\(GameCenterPage, \{/, 'main 槽必须渲染 GameCenterPage');
  // 旧的"按钮打开弹层"占位必须移除
  assert.ok(
    !/useEffect\(\(\) => overlay\.set\(true\)/.test(src),
    '不得再用"进入页面即自动打开弹层"的旧占位',
  );
});

test('导航隐藏并暂停；最终关闭仍保存封存', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterOverlay.js'), 'utf8');
  const pageSrc = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterPage.js'), 'utf8');
  const ctrlSrc = fs.readFileSync(path.resolve(here, '../src/runtime/session-controller.js'), 'utf8');

  // 【PM 硬要求】不得在 React cleanup 里 fire-and-forget 保存。
  // 反模式：useEffect(() => () => { void close('navigate') }) —— iframe 会在存档写完前被卸载。
  assert.ok(
    !/return \(\) => \{[\s\S]{0,300}void closeRef\.current\('navigate'\)/.test(src),
    '禁止在 useEffect cleanup 里 fire-and-forget 触发导航保存（PM 点名的反模式）',
  );
  assert.ok(!src.includes('closeRef'), 'closeRef 反模式必须已移除');

  // 【QA 硬要求 · 真缺陷】绝不跨父节点移动含 iframe 的 DOM 节点。
  // Chromium/WebKit 会在跨父节点 appendChild/insertBefore 时销毁并重建
  // browsing context（iframe 全量 reload、SDK 实例与 MessagePort 全丢）。
  // 因此 host 必须自始至终直属 document.body，只靠 CSS position:fixed 对齐。
  assert.ok(
    !/container\.appendChild\(el\)/.test(ctrlSrc),
    '禁止把 host appendChild 进 React 页面容器（会重载 iframe）',
  );
  assert.ok(
    !/document\.body\.appendChild\(host\)/.test(ctrlSrc),
    '禁止把 host 从页面容器移回 body（跨父节点移动会重载 iframe）',
  );
  assert.match(ctrlSrc, /document\.body\.appendChild\(el\)/, 'host 必须在创建时一次性挂到 document.body');
  assert.match(ctrlSrc, /position: 'fixed'/, 'host 必须用 position:fixed 对齐（CSS 定位，不移动 DOM）');
  assert.match(ctrlSrc, /getBoundingClientRect/, '必须用占位元素矩形做 CSS 对齐');
  assert.match(ctrlSrc, /const align = \(anchor\) =>/, '控制器必须暴露 align 供重对齐');
  assert.match(ctrlSrc, /detachFrame\(\)/, 'ack 完成后才允许移除 iframe');

  // park 只改 CSS，不动父子拓扑
  assert.match(
    ctrlSrc,
    /const parkHost = \(\) => \{\s*if \(host === null\) return;\s*applyParkedStyle\(host\);/,
    'parkHost 必须只改 CSS，不得移动 DOM 父节点',
  );

  // Register the waiter before notifying the game, including synchronous acknowledgements.
  assert.match(
    ctrlSrc,
    /const paused = requestPause\(reason\)[\s\S]*?triggerPause\(\{ reason \}\)[\s\S]*?await paused/,
    '必须先登记确认等待，再发送暂停信号',
  );
  assert.match(
    ctrlSrc,
    /outcome\.kind === 'saved'[\s\S]*?dispose\(\)[\s\S]*?detachFrame\(\)/,
    '只有 saved 才 dispose 并销毁 iframe',
  );
  // 未确认保存：保留容器，不显示已保存
  assert.match(
    ctrlSrc,
    /setState\(SessionState\.FAILED, outcome\.message\)/,
    '未确认保存必须转为 FAILED 并保留容器',
  );

  // 保存必须真的走 requestPause（落盘确认链路），不是只清状态
  assert.match(
    src,
    /const paused = requestPause\(reason\)/,
    '离开路径必须经 requestPause 才能断言"已保存"',
  );
  // 且必须等待 outcome 后按 kind 决定 phase（saved / recovery），失败不得称已保存
  assert.match(
    src,
    /setPhase\(outcome\.kind === 'saved' \? 'paused' : 'recovery'\)/,
    '保存结果必须按 outcome.kind 如实分流，不得一律显示已保存',
  );
  // 落盘确认后必须封存 + 销毁
  assert.match(src, /await abandonLaunch\(runningSession\)/, '保存后必须放弃本次启动（封存）');
  assert.match(src, /runningSession\.dispatcher\.dispose\(\)/, '保存后必须销毁 dispatcher/ports');

  // 页面在"还活着"的两个时机主动收敛（不等卸载，卸载时已来不及）
  assert.match(pageSrc, /visibilitychange/, '页面必须监听 visibilitychange（切后台即收敛）');
  assert.match(pageSrc, /pagehide/, '页面必须监听 pagehide（窗口关闭/刷新）');
  assert.match(pageSrc, /sessionController\.unbind\?\.\(/ , '切后台必须触发收敛');
  assert.match(pageSrc, /sessionController\.finalize\('pagehide'\)/, '窗口关闭必须触发收敛');

  // page 模式的 iframe 必须挂到控制器容器（脱离 React 树），不是 React 内联 iframe
  assert.match(src, /data-gamecenter-frame-slot/, 'page 模式必须有 iframe 挂载槽（控制器命令式插入）');
  assert.match(src, /sessionController\.attach\(/, 'page 模式必须通过控制器 attach iframe');
});

test('诊断弹窗唯一性：page 与 overlay 不得同时渲染两个 dialog', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterOverlay.js'), 'utf8');
  // page 模式的诊断弹窗只在 isPage 分支里挂一次
  const pageBranch = src.slice(src.indexOf('if (isPage) {'));
  assert.match(pageBranch, /diagnosticsOpen\s*&&[\s\S]*?DiagnosticsDialog/, 'page 分支必须挂 DiagnosticsDialog');
  // page 分支不得再出现 RemoteDiagnostics 直挂（那会与 DiagnosticsDialog 双挂载）
  const pageBranchUpToOverlay = pageBranch.slice(0, pageBranch.indexOf('if (!open)'));
  assert.ok(
    !pageBranchUpToOverlay.includes('h(RemoteDiagnostics'),
    'page 分支不得直挂 RemoteDiagnostics（会与 DiagnosticsDialog 双挂载）',
  );
});


test('关闭诊断不得终止游戏：关闭回调只关弹窗，不触发 close()', () => {
  const pageSrc = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterPage.js'), 'utf8');
  // closeDiagnostics 只做两件事：关弹窗状态 + 焦点回跳；不得调用游戏关闭路径
  const closeDiagMatch = pageSrc.match(/const closeDiagnostics = useCallback\((?:[\s\S]*?)\n?\s*\{([\s\S]*?)\}, \[overlay\]\);/);
  assert.ok(closeDiagMatch, '必须找到 closeDiagnostics 定义');
  const body = closeDiagMatch[1];
  assert.ok(!/requestPause/.test(body), '关闭诊断不得触发 requestPause（那会终止游戏）');
  assert.ok(!/abandonLaunch/.test(body), '关闭诊断不得 abandonLaunch（那会封存租约）');
  assert.match(body, /setDiagnosticsOpen\(false\)/, '必须关闭弹窗状态');
  assert.match(body, /\.focus\(\)/, '必须把焦点还给触发按钮');
});

/**
 * 带**浏览语义**的伪 DOM：模拟「跨父节点移动含 iframe 的节点会重建
 * browsing context」这一真实浏览器行为（Chromium/WebKit 标准行为）。
 *
 * 这正是 Node 裸 vm / 简化 mock 测不出来的东西——QA 指出那会产成假阳性。
 * 这里让 `appendChild` 在把已挂载 iframe 的节点换父节点时：
 *   1. 销毁旧 contentWindow（记为 reloaded）；
 *   2. 分配一个全新的 contentWindow 对象。
 * 于是"iframe 是否被重载"变成可断言的机器事实。
 */
function createBrowserLikeDom() {
  /** @type {Map<any, any>} */
  const windows = new Map();
  /** @type {Set<any>} */
  const reloaded = new Set();
  /** @type {Set<any>} */
  const removed = new Set();
  let nextWindowId = 1;

  class FakeNode {
    /** @param {string} tag */
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.parentNode = null;
      /** @type {FakeNode[]} */
      this.childNodes = [];
      this.style = {};
      this.attributes = {};
      this.listeners = {};
      if (this.tagName === 'IFRAME') {
        this.contentWindow = { id: nextWindowId++, destroyed: false };
        windows.set(this, this.contentWindow);
      }
    }
    /**
     * @param {string} name
     * @param {string} value
     */
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    /**
     * @param {string} name
     */
    getAttribute(name) {
      return this.attributes[name];
    }
    /**
     * @param {FakeNode} node
     * @returns {FakeNode}
     */
    appendChild(node) {
      // 【浏览语义】跨父节点移动 → 销毁并重建该子树所有 iframe 的 browsing context
      if (node.parentNode !== null && node.parentNode !== this) {
        destroyIframesIn(node);
      }
      if (node.parentNode !== null) {
        const idx = node.parentNode.childNodes.indexOf(node);
        if (idx >= 0) node.parentNode.childNodes.splice(idx, 1);
      }
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    /**
     * @param {FakeNode} node
     */
    removeChild(node) {
      const idx = this.childNodes.indexOf(node);
      if (idx >= 0) this.childNodes.splice(idx, 1);
      node.parentNode = null;
      // 移除是**显式销毁**（允许），与"跨父节点移动导致的重载"是两回事，
      // 因此只标记 removed，不计入 reloaded。
      removed.add(node);
      return node;
    }
    /**
     * @param {string} type
     * @param {() => void} fn
     */
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    /**
     * @param {string} type
     */
    dispatch(type) {
      for (const fn of this.listeners[type] ?? []) fn();
    }
    /** @returns {{left: number, top: number, width: number, height: number}} */
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 800, height: 600 };
    }
    focus() {}
  }

  /**
   * @param {FakeNode} root
   */
  function destroyIframesIn(root) {
    const stack = [root];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.tagName === 'IFRAME') {
        const w = windows.get(n);
        if (w !== undefined && w.destroyed !== true) {
          w.destroyed = true;
          reloaded.add(n);
          // 重建：分配全新 contentWindow
          n.contentWindow = { id: nextWindowId++, destroyed: false };
          windows.set(n, n.contentWindow);
        }
      }
      for (const c of n.childNodes) stack.push(c);
    }
  }

  const body = new FakeNode('body');
  return { body, FakeNode, reloaded, windows };
}

/** 把 session-controller 源码转成可在 vm 里执行的 CJS。 */
function loadSessionController(sandbox) {
  const src = fs.readFileSync(path.resolve(here, '../src/runtime/session-controller.js'), 'utf8');
  const cjs = src
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/@type\s*\{[^}]*\}/g, '')
    .replace(/@param\s*\{[^}]*\}/g, '')
    .replace(/@returns?\s*\{[^}]*\}/g, '')
    .replace(/@typedef[\s\S]*?\n\s*\*\//g, '')
    .replace(/export const (\w+)/g, 'exports.$1')
    .replace(/export function (\w+)/g, 'exports.$1 = function $1');
  vm.runInNewContext(cjs, sandbox);
  // 源码里 `export const SessionState = Object.freeze({...})` 变成 exports.SessionState，
  // 但函数体内按裸名引用它；这里把导出对象的内容回灌到沙箱全局。
  Object.assign(sandbox, sandbox.exports);
  return sandbox.exports;
}

test('动态卸载验证：park/对齐全程不换父节点，iframe 零重载（带浏览语义的伪 DOM）', async () => {
  const dom = createBrowserLikeDom();
  const { body, FakeNode } = dom;

  const sandbox = {
    document: {
      body,
      createElement: (/** @type {string} */ tag) => new FakeNode(tag),
    },
    exports: {},
  };
  sandbox.module = { exports: sandbox.exports };

  /** @type {string[]} */
  const order = [];
  let releasePause = () => {};
  let markPauseStarted;
  const pauseStarted = new Promise(resolve => { markPauseStarted = resolve; });
  const controller = loadSessionController(sandbox);
  const ctrl = controller.createGameSessionController({
    requestPause: (/** @type {string} */ reason) => {
      order.push(`requestPause:${reason}`);
      return new Promise((resolve) => {
        releasePause = () => resolve({ kind: 'saved', message: '已保存' });
        markPauseStarted();
      });
    },
  });

  // 页面里的占位元素（React 渲染的 slot）
  const anchor = new FakeNode('div');
  body.appendChild(anchor);

  const session = {
    gameId: 'g', commit: 'c', title: 't', runtimeInstanceId: 'rt-1', nonce: 'n',
    launchToken: 'l', runtimeToken: 'tok', lease: {}, docHtml: '', blobUrl: null,
    dispatcher: {
      triggerPause: (/** @type {any} */ o) => order.push(`triggerPause:${o.reason}`),
      dispose: () => order.push('dispose'),
    },
  };

  // 1) attach：host 创建并挂到 body，随后 CSS 对齐到 anchor
  ctrl.attach(session, { sandbox: 'allow-scripts', frameMode: 'srcdoc', anchor });
  const info1 = ctrl.debugInfo();
  assert.equal(info1.hasFrame, true, '必须创建 iframe');
  assert.equal(info1.hostParentIsBody, true, 'host 必须直属 document.body');

  // 找到 iframe 与 host，记录身份
  const hostNode = body2Host(dom);
  assert.ok(hostNode, 'host 必须在 DOM 里');
  let frameNode = null;
  {
    const stack = [body];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.tagName === 'IFRAME') frameNode = n;
      for (const c of n.childNodes) stack.push(c);
    }
  }
  assert.ok(frameNode, '必须能在 DOM 里找到 iframe');
  const windowBefore = frameNode.contentWindow;

  // 2) 模拟"导航离开"：先 park（只改 CSS），再启动收敛
  ctrl.align(null); // 页面不可见 → 收起（仅改 CSS）
  const pending = ctrl.finalize('close');

  // 【关键断言 1】收敛**进行中**（ack 之前）iframe 必须原样存活
  assert.equal(dom.reloaded.has(frameNode), false, 'ack 前不得重载 iframe');
  assert.equal(frameNode.contentWindow, windowBefore, 'ack 前 contentWindow 身份必须不变');
  assert.equal(frameNode.parentNode, hostNode, 'ack 前 iframe 的父节点必须仍是 host（未换父）');
  assert.equal(hostNode.parentNode, body, 'host 必须始终直属 document.body');

  // 【关键断言 2】ack 之前 host 的样式必须是收起态（屏幕外）
  assert.equal(hostNode.style.position, 'fixed', 'park 后 host 应为 fixed');
  assert.equal(hostNode.style.opacity, '0', 'park 后 host 应不可见');

  // 3) 等待真实暂停入口已受理，再放行 ack（不依赖微任务执行时序）。
  await pauseStarted;
  releasePause();
  const outcome = await pending;
  assert.equal(outcome.kind, 'saved');

  // 4) saved 之后才允许移除 iframe（这是正确行为，不是"重载"）
  assert.equal(ctrl.debugInfo().hasFrame, false, 'ack 后 iframe 才被移除');
  assert.equal(ctrl.debugInfo().hasHost, true, 'host 保留（可复用），不随会话销毁');
  assert.equal(dom.reloaded.has(frameNode), false, 'ack 后的移除是正常销毁，不应计入"跨父节点重载"');
});

/**
 * 在伪 DOM 里找到 host 节点（带 data-gamecenter-session-host 属性）。
 * @param {any} dom
 * @returns {any}
 */
function body2Host(dom) {
  const stack = [dom.body];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n.getAttribute?.('data-gamecenter-session-host') !== undefined) return n;
    for (const c of n.childNodes) stack.push(c);
  }
  return null;
}

test('动态卸载验证：收敛失败时 iframe 仍存活且全局提示可见可重试', async () => {
  const dom = createBrowserLikeDom();
  const { body, FakeNode } = dom;

  const sandbox = {
    document: {
      body,
      createElement: (/** @type {string} */ tag) => new FakeNode(tag),
    },
    exports: {},
  };
  sandbox.module = { exports: sandbox.exports };

  let attempts = 0;
  const controller = loadSessionController(sandbox);
  const ctrl = controller.createGameSessionController({
    requestPause: async () => {
      attempts += 1;
      if (attempts === 1) return { kind: 'timeout', message: '保存超时，已回落到最近检查点' };
      return { kind: 'saved', message: '已保存' };
    },
  });

  const session = {
    gameId: 'g', commit: 'c', title: 't', runtimeInstanceId: 'rt-1', nonce: 'n',
    launchToken: 'l', runtimeToken: 'tok', lease: {}, docHtml: '', blobUrl: null,
    dispatcher: { triggerPause: () => {}, dispose: () => {} },
  };
  ctrl.attach(session, { sandbox: 'allow-scripts', frameMode: 'srcdoc', anchor: null });

  let frameNode = null;
  {
    const stack = [body];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.tagName === 'IFRAME') frameNode = n;
      for (const c of n.childNodes) stack.push(c);
    }
  }
  const windowBefore = frameNode.contentWindow;

  // 第一次收敛失败
  const first = await ctrl.finalize('navigate');
  assert.equal(first.kind, 'timeout');
  assert.equal(ctrl.snapshot().state, 'failed');

  // iframe 必须仍在（未销毁、未重载）
  assert.equal(ctrl.debugInfo().hasFrame, true, '收敛失败不得销毁 iframe');
  assert.equal(dom.reloaded.has(frameNode), false, '收敛失败不得重载 iframe');
  assert.equal(frameNode.contentWindow, windowBefore, 'contentWindow 身份必须不变');

  // 全局提示必须已挂在 body 上（页面卸载后仍可见）
  let notice = null;
  {
    const stack = [body];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.getAttribute?.('data-gamecenter-global-notice') !== undefined) notice = n;
      for (const c of n.childNodes) stack.push(c);
    }
  }
  assert.ok(notice, '收敛失败必须挂全局提示（直属 body，页面卸载后仍可见）');
  assert.equal(notice.getAttribute('role'), 'alert', '提示必须是 role=alert');

  // 提示必须带重试按钮，点击后重试并最终成功
  const retryBtn = notice.childNodes.find((/** @type {any} */ c) => c.getAttribute?.('data-gamecenter-action') === 'retry-save');
  assert.ok(retryBtn, '必须提供重试按钮');
  retryBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(attempts, 2, '重试必须再次触发 requestPause');
  assert.equal(ctrl.snapshot().state, 'saved', '重试成功后状态应为 saved');
  assert.equal(ctrl.debugInfo().hasFrame, false, '重试成功后 iframe 才移除');
});
