/**
 * 验证 `@dsh-gamecenter/client` 能否被 `dsh-client-modules` 的发现链找到，
 * 并确认 Host 半入口在 Node 里可被**求值**（不是只可解析路径）。
 *
 * 复刻 `resolveMeta()` 的判定链：
 *   1. `exactPackageSpecifier(loaderName)` —— Loader 条目名必须是精确包名
 *   2. `internal.resolveSync(loaderName, baseUrl)` —— 必须能解析到模块 URL
 *   3. `nearestPackage(moduleUrl, expectedPackageName)` —— 沿 URL 向上找同名 package.json
 *   4. 读 `dsh.client` 与 `exports["./client"]` 得出 clientPath
 *
 * 本脚本用自己的 Node 解析代替 DSH 的 internal.resolveSync（二者对包名解析语义一致），
 * 额外多做一步：**真正 import 一次 `exports["."]`**，证明浏览器 bundle 不会被误求值。
 *
 * 用法：node tools/probe-loader-resolution.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const require = createRequire(path.join(root, 'package.json'));

/** 复刻 `exactPackageSpecifier`。 */
function exactPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined;
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined;
}

/**
 * @param {string} loaderName
 * @returns {{ok: boolean, reason?: string, pkgPath?: string, pkg?: any, clientPath?: string}}
 */
function resolveMeta(loaderName) {
  // 1. 精确包名
  const expectedPackageName = exactPackageSpecifier(loaderName);
  if (expectedPackageName === undefined) {
    return { ok: false, reason: `exactPackageSpecifier("${loaderName}") 返回 undefined（不是精确包名）` };
  }

  // 2. 解析到模块 URL（等价于 internal.resolveSync）
  let moduleUrl;
  try {
    moduleUrl = pathToFileURL(require.resolve(loaderName)).href;
  } catch (error) {
    return { ok: false, reason: `resolveSync 失败：${error.message}` };
  }

  // 3. nearestPackage：向上找 name 相符的 package.json
  let dir = path.dirname(fileURLToPath(moduleUrl));
  let pkgPath;
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed.name === expectedPackageName) {
        pkgPath = candidate;
        break;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (pkgPath === undefined) {
    return { ok: false, reason: `nearestPackage 未找到 name === ${expectedPackageName} 的 package.json` };
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  // 4. dsh.client + exports["./client"]
  const decl = pkg.dsh?.client;
  if (decl === undefined || decl.platform !== 'web') {
    return { ok: false, reason: 'dsh.client 缺失或 platform !== "web"' };
  }
  const target = pkg.exports?.['./client'];
  const clientRel = typeof target === 'string' ? target : target?.default;
  if (typeof clientRel !== 'string') {
    return { ok: false, reason: 'exports["./client"] 缺失（resolveMeta 会抛错）' };
  }
  return {
    ok: true,
    pkgPath,
    pkg,
    clientPath: path.join(path.dirname(pkgPath), clientRel),
  };
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const loaderName = pkg.name;

console.log(`Loader 条目名: ${JSON.stringify(loaderName)}`);
const result = resolveMeta(loaderName);

if (!result.ok) {
  console.log(`RESULT=FAIL  ${result.reason}`);
  process.exitCode = 1;
} else {
  console.log(`RESULT=OK`);
  console.log(`  pkgPath    = ${path.relative(root, String(result.pkgPath))}`);
  console.log(`  clientPath = ${path.relative(root, String(result.clientPath))}`);
  console.log(`  产物存在   = ${existsSync(String(result.clientPath))}`);

  const body = readFileSync(String(result.clientPath), 'utf8');
  console.log(`  产物首行   = ${body.split('\n')[0]}`);
  console.log(`  产物形态   = ${/^\s*window\.__ModuleLoader__\.load\(\{/.test(body) ? 'factory 注册' : '非 factory'}`);
}

console.log('');
console.log('=== 关键验证：Node 求值 exports["."] 会不会崩 ===');
const hostEntry = pkg.exports?.['.']?.default;
console.log(`exports["."].default = ${JSON.stringify(hostEntry)}`);
try {
  const mod = await import(pathToFileURL(path.join(root, String(hostEntry))).href);
  console.log(`  求值成功，导出 = ${Object.keys(mod).join(', ')}`);
} catch (error) {
  console.log(`  求值失败：${error.message}`);
  process.exitCode = 1;
}

console.log('');
console.log('=== 反证：若 "." 指向浏览器 bundle 会怎样 ===');
try {
  await import(pathToFileURL(String(result.clientPath)).href);
  console.log('  意外：浏览器 bundle 在 Node 中求值成功（说明 window 存在？）');
} catch (error) {
  console.log(`  预期失败：${error.constructor.name}: ${error.message}`);
  console.log('  → 这就是为什么 "." 必须指向 Host 半入口而不是 dist/client.js');
}
