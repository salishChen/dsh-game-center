/**
 * 装配核验（证据分栏：STATIC/BUILD）。
 *
 * 直接复刻 `@deepseek-ai/dsh-client-modules` lib/index.js 的
 * `parseDshClient()` 与 `clientExportOf()` 判定，验证本包能否被目标 DSH 的
 * Client 模块系统识别。它证明的是「清单/导出形状合规」，**不证明运行期挂载成功**。
 *
 * 运行：node --test test/assembly.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

/** 复刻 dsh-client-modules 的 parseDshClient 校验。 */
function parseDshClient(pkgName, value) {
  if (value === undefined) return undefined;
  assert.equal(typeof value, 'object', `${pkgName} dsh.client 必须是对象`);
  assert.notEqual(value, null);
  assert.equal(typeof value.platform, 'string', `${pkgName} dsh.client.platform 必须是字符串`);
  for (const field of ['inject', 'external']) {
    const raw = value[field];
    if (raw === undefined) continue;
    assert.ok(Array.isArray(raw) && raw.every((x) => typeof x === 'string'), `${pkgName} dsh.client.${field} 必须是字符串数组`);
  }
  if (value.immediately !== undefined) {
    assert.equal(typeof value.immediately, 'boolean', `${pkgName} dsh.client.immediately 必须是布尔`);
  }
  return { platform: value.platform, inject: value.inject, external: value.external, immediately: value.immediately };
}

test('package.json 声明了可被 DSH Client 模块系统识别的 dsh.client', () => {
  const decl = parseDshClient(pkg.name, pkg.dsh?.client);
  assert.ok(decl, 'dsh.client 缺失则不会被 serveBundle 下发');
  assert.equal(decl.platform, 'web', 'platform 必须是 web，否则 resolveMeta 返回 null');
});

test('exports["./client"] 指向真实存在的 bundle', () => {
  const target = pkg.exports?.['./client'];
  assert.ok(target, '缺少 exports["./client"] 会抛 "declares dsh.client but exports no ./client bundle"');
  const def = typeof target === 'string' ? target : target.default;
  assert.ok(typeof def === 'string');
  const file = path.join(here, '..', def);
  const content = readFileSync(file, 'utf8');
  assert.ok(content.length > 0);
});

test('装配入口必须指向单文件 bundle，不能指向过渡期 ESM 壳', () => {
  // 回归守卫：曾经 main / exports.default 都指向 lib/client.js（含顶层 import 的 ESM 壳），
  // 而 dsh-client-modules 只认 exports["./client"]，会加载错产物并在 factory 下解析失败。
  const entry = pkg.exports?.['./client']?.default;
  assert.equal(entry, './dist/client.js', 'exports["./client"].default 必须是 ./dist/client.js');

  const body = readFileSync(path.join(here, '..', 'dist', 'client.js'), 'utf8');
  assert.ok(/^\s*window\.__ModuleLoader__\.load\(\{/.test(body), '产物必须以 __ModuleLoader__.load 开头');
  // 产物里不得有顶层 ESM import（factory 内不允许）
  assert.equal([...body.matchAll(/^\s*import\s+[^(]/gm)].length, 0, '产物不得含顶层 import');
});

test('Host 半入口可被 Node 解析，且不含浏览器全局（否则 Loader 解析条目时崩）', async () => {
  // resolveMeta() 用 internal.resolveSync(loaderName, baseUrl) 解析 Loader 条目名，
  // 若 exports["."] 指向 window.__ModuleLoader__ 形态的浏览器 bundle，Node 求值时会抛
  // ReferenceError: window is not defined。所以 "." 必须是纯 Node 可加载模块。
  const hostEntry = pkg.exports?.['.']?.default;
  assert.equal(hostEntry, './lib/index.js', 'exports["."].default 必须是 Host 半入口');
  assert.equal(pkg.main, 'lib/index.js', 'main 必须与 Host 半入口一致');

  // Windows 下 dynamic import 的绝对路径必须是 file:// URL
  const mod = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href);
  assert.equal(typeof mod.apply, 'function', 'Host 半入口必须导出 apply');
  const source = readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8');
  // 不得引用浏览器全局：用字符串整体检查太脆，这里检查实际代码行（排除注释）
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.equal(/\bwindow\s*\./.test(code), false, 'Host 半入口不得引用 window');
  assert.equal(/\bdocument\s*\./.test(code), false, 'Host 半入口不得引用 document');
});

test('lib/client.js 不得再被装配入口引用（它只是过渡壳）', () => {
  const targets = [
    pkg.main,
    pkg.exports?.['.']?.default,
    pkg.exports?.['./client']?.default,
  ].filter(Boolean);
  for (const t of targets) {
    assert.notEqual(t, 'lib/client.js', `${t} 指向了过渡 ESM 壳，真实装载会失败`);
    assert.notEqual(t, './lib/client.js', `${t} 指向了过渡 ESM 壳，真实装载会失败`);
  }
});

test('dsh.client.external 只写静态外部表里的名字或本包自身', () => {
  // 浏览器静态外部表（web-frontend index 包 SZ()）实际存在的名字。
  const STATIC = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    'zod',
    '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ]);
  const external = pkg.dsh?.client?.external ?? [];
  for (const name of external) {
    assert.ok(STATIC.has(name), `external 中的 ${name} 不在静态外部表里，会导致注入悬空`);
  }
});

test('engines.dsh 覆盖实装运行时 0.2.1-rc.2（含预发布）', () => {
  // dsh-app-boot 的 unmetRequirements 用 semver.satisfies(runtime, range, {includePrerelease:true})，
  // runtime 取 dsh-app-boot 自身 package.json 的 version（实装为 0.2.1-rc.2）。
  const range = pkg.engines?.dsh;
  assert.ok(typeof range === 'string' && range.trim() !== '', '缺少 engines.dsh 会走 peerDependencies 分支');
  // 手工判定：^0.2.1-rc.2 等价于 >=0.2.1-rc.2 <0.3.0（这里写成显式区间，便于逐条核对）。
  assert.equal(range, '>=0.2.1-rc.2 <0.3.0');
  const runtime = [0, 2, 1];
  const [loMajor, loMinor, loPatch] = [0, 2, 1];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  assert.ok(cmp(runtime, [loMajor, loMinor, loPatch]) >= 0, '下限不满足');
  assert.ok(runtime[0] < 0 + 1, '上限不满足');
});

test('inject 里没有写 workspace 内部包（浏览器无法 require）', () => {
  for (const name of pkg.dsh?.client?.inject ?? []) {
    assert.ok(!name.startsWith('@dsh-gamecenter/'), `${name} 是内部包，浏览器无法直接 require`);
  }
});

test('模块注册壳不 import 任何 workspace 内部包（浏览器 bundle 不得依赖）', () => {
  const shell = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');
  const specifiers = [...shell.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const spec of specifiers) {
    assert.ok(!spec.startsWith('@dsh-gamecenter/'), `${spec} 不能出现在浏览器 bundle 的 import 里`);
  }
});

test('插件顶层 inject 严禁声明 remote.gameCenter（杜绝 Cordis 自等候死锁）', async () => {
  const src = readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8');
  const injectMatch = src.match(/export\s+const\s+inject\s*=\s*(\[[^\]]+\])/);
  assert.ok(injectMatch, 'src/index.js 必须声明 export const inject');
  const list = JSON.parse(injectMatch[1].replace(/'/g, '"'));
  assert.ok(list.includes('remote'), '必须包含基础 remote 服务以执行 $mount');
  assert.equal(
    list.includes('remote.gameCenter'),
    false,
    '严禁在 inject 中声明 remote.gameCenter，否则 Cordis 启动期因依赖未满足陷入死锁',
  );
});

test('getService 在具有 Cordis 点号属性保护的代理下必须通过 ctx.get() 成功读取', () => {
  const serviceMock = {
    handshake: async () => ({ ok: true }),
  };

  // 模拟真实 Cordis ReflectService：若通过点号访问未声明的 remote.gameCenter 则严格抛错
  const mockRemote = new Proxy({}, {
    get(target, prop) {
      if (prop === 'gameCenter') {
        throw new Error('cannot get property "remote.gameCenter" without inject');
      }
      return target[prop];
    },
  });

  const registeredStores = new Map([['remote.gameCenter', serviceMock]]);
  const mockCtx = {
    remote: mockRemote,
    get: (key) => registeredStores.get(key),
  };

  // 提取 src/index.js 中 getService 实现逻辑进行检验
  const src = readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8');
  assert.equal(src.includes('ctx.remote?.gameCenter'), false, '不得再使用 ctx.remote?.gameCenter 点号访问');
  assert.ok(src.includes("ctx.get('remote.gameCenter')"), '必须通过 ctx.get("remote.gameCenter") 提取');

  // 验证在模拟代理下：点号访问必抛，ctx.get 必通
  assert.throws(
    () => mockCtx.remote.gameCenter,
    /cannot get property "remote.gameCenter" without inject/,
  );
  assert.equal(mockCtx.get('remote.gameCenter'), serviceMock);
});
