/**
 * 只读检查：workspace 内 `dependencies` 是否成环，以及环内包是否都是私有包。
 *
 * 【历史（别删，这是一次被推翻的判断）】
 * 为了让 `dsh-client-modules` 的 `nearestPackage()` 沿模块 URL 找到 Client 包，
 * 我曾给 Client 加 `dependencies["@dsh-gamecenter/host"]`，理由写的是
 * 「`createRequire(baseUrl).resolve(name/package.json)` 需要真实依赖声明」。
 * 这个理由**不成立**：`createRequire(baseUrl)` 用的是 **baseUrl 所在位置**的
 * node_modules 链，不是 Client 包自己的依赖表；而 Client 包名在包内靠
 * **self-reference**（`exports` 字段）就能解析。该依赖收益为零，却造出
 * `host → client → host` 的循环依赖。测试与发布负责人推翻锚点方案后，
 * 这条依赖已撤回，工程恢复为单向 `host → client`。
 *
 * 【本脚本现在的作用】
 * 防止环再次被无意引入（例如又有人为了"保险"加一条反向依赖）。
 * 若将来真的必须成环，环内每个包都必须是 `private: true` 且版本 `0.0.0`。
 *
 * 用法：node tools/check-dependency-cycle.mjs
 * 退出码：0 = 无环，或环内全部为私有 workspace 包；1 = 出现非预期情况。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesRoot = path.join(here, '..', '..', '..', 'packages');

if (!existsSync(packagesRoot)) {
  console.log(`RESULT=FAIL —— 找不到 workspace packages 目录：${packagesRoot}`);
  process.exit(1);
}

/** @type {Map<string, {dir: string, pkg: any, deps: string[], devDeps: string[]}>} */
const packages = new Map();
for (const dir of readdirSync(packagesRoot)) {
  const pkgPath = path.join(packagesRoot, dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  packages.set(pkg.name, {
    dir,
    pkg,
    deps: Object.keys(pkg.dependencies ?? {}),
    devDeps: Object.keys(pkg.devDependencies ?? {}),
  });
}

console.log('=== workspace dependencies（不含 devDependencies） ===');
for (const [name, info] of packages) {
  console.log(`  ${name}  (packages/${info.dir})`);
  console.log(`    dependencies    = ${info.deps.join(', ') || '（无）'}`);
  console.log(`    devDependencies = ${info.devDeps.join(', ') || '（无）'}`);
}

/** 深度优先找出 dependencies 图上所有环。 */
function findCycles() {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...packages.keys()].map((name) => [name, WHITE]));
  /** @type {string[][]} */
  const cycles = [];
  /** @type {string[]} */
  const stack = [];

  /** @param {string} name */
  function visit(name) {
    color.set(name, GRAY);
    stack.push(name);
    for (const dep of packages.get(name)?.deps ?? []) {
      if (!packages.has(dep)) continue; // 外部包不参与 workspace 环判定
      const c = color.get(dep);
      if (c === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      } else if (c === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(name, BLACK);
  }

  for (const name of packages.keys()) if (color.get(name) === WHITE) visit(name);
  return cycles;
}

const cycles = findCycles();
console.log('');
console.log('=== dependencies 环检测 ===');
if (cycles.length === 0) console.log('  未发现环。');
for (const cycle of cycles) console.log(`  环：${cycle.join(' → ')}`);

const offending = [];
for (const cycle of cycles) {
  for (const name of cycle) {
    const info = packages.get(name);
    if (!info) continue;
    if (info.pkg.private !== true) offending.push(`${name} 不是 private`);
    if (info.pkg.version !== '0.0.0') {
      offending.push(`${name} 版本是 ${String(info.pkg.version)}（预期 0.0.0，避免被当作可发布包）`);
    }
  }
}

console.log('');
if (offending.length > 0) {
  for (const line of offending) console.log(`FAIL  ${line}`);
  console.log('RESULT=FAIL —— 环内存在非私有/可发布包，安装顺序与发布语义不可控');
  process.exit(1);
}

console.log(
  cycles.length === 0
    ? 'RESULT=PASS —— 无环'
    : 'RESULT=PASS —— 环存在且全部是 private workspace 包 @0.0.0（已知结构，见文件头说明）',
);
