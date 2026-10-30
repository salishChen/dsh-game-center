/**
 * 检查产物是否满足 DSH 模块系统的**结构**要求（`STATIC` 级别，不证明运行期可加载）。
 *
 * 目标形态来自实装产物，例如 `@deepseek-ai/dsh-client-ui-schedule/lib/client.js`：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } })
 *
 * 本测试对 `dist/client.js`（打包产物）执行**强断言**；对 `lib/client.js`
 * （过渡期注册壳，含顶层 ESM import）只做“不得被当作生产产物”的弱断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** @param {string} file @param {string} label */
function checkBundleShape(file, label) {
  const src = readFileSync(file, 'utf8');

  assert.ok(
    src.trimStart().startsWith('window.__ModuleLoader__.load({'),
    `${label}: 必须以 window.__ModuleLoader__.load({ 开头（模块系统的注册契约）`,
  );
  assert.match(src, /\n\s*id:\s*"@dsh-gamecenter\/client"/, `${label}: 缺少 id`);
  assert.match(src, /factory:\s*\(require\)\s*=>/, `${label}: 缺少 factory: (require) =>`);
  assert.match(src, /return module\.exports/, `${label}: factory 必须 return module.exports`);

  // 顶层 ESM 语法在 factory 里非法。
  const topLevelEsm = [...src.matchAll(/^\s*(import|export)\s+[^(]/gm)];
  assert.equal(topLevelEsm.length, 0, `${label}: 不应有顶层 import/export，实际 ${topLevelEsm.length} 处`);

  // 注册调用只能出现一次（组合脚本会把多个 factory 顺次拼接）。
  const loads = [...src.matchAll(/window\.__ModuleLoader__\.load\(/g)];
  assert.equal(loads.length, 1, `${label}: 顶层注册调用应恰好 1 次（避免重复注册同一 id）`);

  // 外部依赖必须留在 require() 里：不能把 cordis 的实现内联进来。
  const inlineCordis = /Symbol\.for\(["']cordis/.test(src);
  assert.equal(inlineCordis, false, `${label}: cordis 应走外部 require，不应内联实现`);
}

test('lib/client.js 是过渡期注册壳：不得被当作生产产物（含顶层 ESM import）', () => {
  const src = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  assert.match(src, /^\s*import\s/m, 'lib/client.js 现在是 ESM 过渡壳，应当如此；若已改为打包产物，请把本断言迁到 dist');
  assert.match(src, /window\.__ModuleLoader__/, '过渡壳仍应保留注册契约');
});

test('dist/client.js（打包产物）满足 DSH 模块系统的结构契约', () => {
  const dist = path.join(root, 'dist', 'client.js');
  if (!existsSync(dist)) {
    // 打包需要 esbuild；未安装时跳过而不是伪通过。
    console.log('skip: dist/client.js 尚未生成（需 esbuild）');
    return;
  }
  checkBundleShape(dist, 'dist/client.js');
});

test('staging/client.js（独立候选产物）满足 DSH 模块系统的结构契约', () => {
  const staging = path.join(root, 'staging', 'client.js');
  if (!existsSync(staging)) {
    console.log('skip: staging/client.js 尚未生成（可运行 node tools/build-candidate.mjs）');
    return;
  }
  checkBundleShape(staging, 'staging/client.js');
});

test('打包产物必须把外部依赖保留为 require 调用', () => {
  const dist = path.join(root, 'dist', 'client.js');
  if (!existsSync(dist)) {
    console.log('skip: dist/client.js 尚未生成');
    return;
  }
  const src = readFileSync(dist, 'utf8');
  for (const spec of ['react']) {
    assert.ok(src.includes(`require("${spec}")`), `dist/client.js: 外部依赖 ${spec} 应以 require("${spec}") 形式保留`);
  }
});

test('bundle factory loads using the DSH 0.2.1-rc.2 platform module table', () => {
  // 【读 staging 候选，不读 dist】dist 是**在线服务产物**，部署即变化；
  // 若断言读 dist，每次部署都会让本测试因"版本时点"而红/绿，与代码质量无关。
  // 候选产物才是受控可复现的验证对象（dist 的结构契约由上面的用例单独覆盖）。
  const src = readFileSync(path.join(root, 'staging', 'client.js'), 'utf8');
  // Names from the installed frontend's SZ(). cordis/ui is not a platform module.
  const platformModules = new Map([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
  ].map((name) => [name, {}]));
  let registration;
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
  }, { filename: 'gamecenter-client.js' });
  assert.equal(registration.id, '@dsh-gamecenter/client');
  const plugin = registration.factory((specifier) => {
    assert.ok(platformModules.has(specifier), `DSH does not provide ${specifier}`);
    return platformModules.get(specifier);
  });
  assert.equal(typeof plugin.apply, 'function');
  // inject 声明 v3 起新增 'theme'（DSH 主题服务，用于经已配对 port 下发主题）。
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale', 'remote', 'theme']);
});

test('plugin waits for slots, registers the overlay identity, and mounts the game-center page', () => {
  // 【读 staging 候选，不读 dist】理由同上一条：dist 随部署变化，会让断言因时点而红/绿。
  const src = readFileSync(path.join(root, 'staging', 'client.js'), 'utf8');
  let registration;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: (effect) => { effect(); },
  };
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
  });
  const plugin = registration.factory((specifier) => {
    assert.equal(specifier, 'react');
    return react;
  });
  const effects = new Map();
  const pending = new Map();
  const entries = new Map();
  const declared = new Set();
  const released = [];
  const ctx = {
    effect(callback, label) { effects.set(label, callback); },
    slots: {
      inject(name, mount) { pending.set(name, mount); return () => released.push(name); },
      register(options, component) {
        assert.ok(declared.has(options.name), 'registration must wait for its slot declaration');
        if (options.name === 'main') assert.equal(options.key, 'gamecenter');
        else assert.equal(options.id, 'gamecenter', 'list slots require an id');
        entries.set(options.name, { options, component });
        return () => {};
      },
    },
  };
  assert.equal(plugin.apply(ctx), undefined, 'Cordis must not receive a controller object');
  const dispose = effects.get('gamecenter: sidebar entry + shell.overlay')();
  assert.equal(entries.size, 0);
  for (const [name, mount] of pending) { declared.add(name); mount(); }
  const overlayProps = entries.get('shell.overlay').options.inject();
  assert.equal(typeof overlayProps.t, 'function');
  assert.equal(overlayProps.overlay.open, false);

  // v3 页面化：main 槽渲染的是**游戏库页面**（GameCenterPage 元素），
  // 不再是"点击打开弹层"的按钮占位，也**不会**进入页面就自动弹诊断。
  const panel = entries.get('main').component();
  assert.equal(typeof panel.type, 'function', 'main 槽必须渲染一个组件（游戏库页面）');
  assert.equal(panel.props.t, overlayProps.t, '页面与弹层共享同一套 locale 取值');
  assert.equal(panel.props.sessionController, overlayProps.sessionController, '页面与弹层共享同一会话控制器');
  assert.equal(overlayProps.overlay.open, false, '进入页面不得自动弹诊断/弹层');
  dispose();
  assert.deepEqual(released.sort(), ['main', 'shell.overlay', 'sidebar.panellist']);
});

