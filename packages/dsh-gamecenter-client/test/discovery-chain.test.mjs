/**
 * 发现链守卫（证据分栏：STATIC）。
 *
 * 【本文件记录一次被推翻的判断，别删这段】
 * 我最初认为「Host 产物静态 import Client 包」能让 Client 被发现，于是给 Client 加了
 * `dependencies["@dsh-gamecenter/host"]`。测试与发布负责人按源码复刻后推翻：
 * `locatePkgJson:765` 的 `expectedPackageName = exactPackageSpecifier(loaderName)`
 * 恒等于**该条 Loader 条目的 name**，而 `nearestPackage:800` 要求 `pkg.name === expectedPackageName`。
 * 所以 name = `@dsh-gamecenter/host` 的条目只会解析出 Host 包。Host 能否 import Client，
 * 与 resolveMeta 是否会发现 Client，是两件事。Client 必须有**自己的**Loader 条目。
 *
 * 由此我也撤回了那条 `@dsh-gamecenter/host` 依赖：`createRequire(baseUrl).resolve()`
 * 需要的是 **baseUrl 所在位置**的 node_modules 链，而不是 Client 包自己的依赖表；
 * Client 包名在包内靠 **self-reference** 就能解析（本文件第 3 条测试实测证明）。
 * 那条依赖的收益为零，却造出一个 workspace 循环依赖。
 *
 * 本测试断言的是 package.json 层面的事实（不读 Host 源码、不改 Host 文件）：
 *   1. Client 包名是精确包名，且能在包内被 self-reference 解析（发现链的第一环）
 *   2. Client 不声明 Host 依赖（避免循环依赖；收益为零）
 *   3. Host 声明 Client 依赖（解析保险，仅当 Loader baseUrl 落在 Host 包目录时有用）
 *   4. Host 的 cordis.patch.yml 必须给 Client 单独一条 Loader 条目
 *   5. dsh.client 与 exports["./client"] 仍然完整（发现链的其余环节没被改坏）
 *
 * 运行：node --test test/discovery-chain.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.join(here, '..');
const hostRoot = path.join(clientRoot, '..', 'dsh-gamecenter');

const clientPkgPath = path.join(clientRoot, 'package.json');
const clientPkg = JSON.parse(readFileSync(clientPkgPath, 'utf8'));
const clientRequire = createRequire(pathToFileURL(clientPkgPath).href);

/** Host 包可能尚未存在（独立检出时），此时跳过 Host 侧断言并显式报告。 */
const hostPkgPath = path.join(hostRoot, 'package.json');
const hostPkg = existsSync(hostPkgPath) ? JSON.parse(readFileSync(hostPkgPath, 'utf8')) : undefined;

test('Client 包名是精确包名，且能在包内被 self-reference 解析（发现链第一环）', () => {
  // exactPackageSpecifier：@scope/name 恰好两段且都非空
  const parts = clientPkg.name.split('/');
  assert.equal(parts.length, 2, '包名必须是 @scope/name 两段，否则 exactPackageSpecifier 返回 undefined');
  assert.ok(parts[0].startsWith('@') && parts[0].length > 1, '@scope 段不能为空');
  assert.ok(parts[1].length > 0, 'name 段不能为空');

  // 实测：从包内解析自己的包名，必须落到本包，且不经过任何 node_modules 软链。
  const resolved = clientRequire.resolve(`${clientPkg.name}/package.json`);
  assert.equal(
    path.resolve(resolved),
    path.resolve(clientPkgPath),
    'Client 包名必须能 self-reference 解析到本包（依赖 exports 字段而非软链）',
  );
  assert.equal(
    resolved.includes(`${path.sep}node_modules${path.sep}`),
    false,
    'self-reference 不应经过 node_modules；若经过说明实际是靠软链，结论不成立',
  );
});

test('Client 不声明 Host 依赖（撤回：收益为零且造出循环依赖）', () => {
  assert.equal(
    clientPkg.dependencies?.['@dsh-gamecenter/host'],
    undefined,
    'Client 不得声明 @dsh-gamecenter/host 依赖；Client 包名靠 self-reference 解析，不靠对端软链',
  );
  assert.equal(
    clientPkg.devDependencies?.['@dsh-gamecenter/host'],
    undefined,
    'devDependencies 里也不该出现 Host 包（它不参与本包构建）',
  );
});

test('Host 声明 Client 依赖（解析保险：仅当 Loader baseUrl 落在 Host 包目录时才有用）', () => {
  if (hostPkg === undefined) {
    assert.ok(true, 'Host 包不在当前检出中，Host 侧断言交由 Host 包自身的测试覆盖');
    return;
  }
  assert.equal(
    hostPkg.dependencies?.['@dsh-gamecenter/client'],
    'workspace:*',
    'Host 的 dependencies 应含 @dsh-gamecenter/client: "workspace:*"，让 Loader 条目名可经 Host 的 node_modules 链解析',
  );
  // 说明边界：这条保险只在 baseUrl 落在 Host 包目录时生效；若落在 profile 目录，
  // 解析取决于 profile 的安装方式 —— 那是 DSH-REAL 待验项，本测试不假装它已成立。
  const hostLink = path.join(hostRoot, 'node_modules', '@dsh-gamecenter', 'client');
  if (existsSync(path.join(hostRoot, 'node_modules'))) {
    assert.ok(
      existsSync(hostLink),
      `Host 包内必须真有软链 ${hostLink}（pnpm install 缺失会让解析静默失败）`,
    );
  }
});

test('Host 的 cordis.patch.yml 必须给 Client 单独一条 Loader 条目（静态 import 锚点不成立）', () => {
  const patchPath = path.join(hostRoot, 'cordis.patch.yml');
  if (!existsSync(patchPath)) {
    assert.ok(true, 'Host patch 不在当前检出中，交由 Host 包自身的 verify-load-prereqs 覆盖');
    return;
  }
  const text = readFileSync(patchPath, 'utf8');
  // 只扫 insert: 之后的部分，避免注释里出现的包名造成假通过。
  const insertAt = text.indexOf('insert:');
  assert.ok(insertAt >= 0, 'cordis.patch.yml 必须有 insert: 段');
  const insertBody = text.slice(insertAt);
  const names = [...insertBody.matchAll(/^\s*-?\s*name:\s*["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  assert.ok(
    names.includes('@dsh-gamecenter/client'),
    `insert 段必须含 name: "@dsh-gamecenter/client" 的条目，实际条目名 = ${JSON.stringify(names)}`,
  );
  assert.ok(
    names.includes('@dsh-gamecenter/host'),
    `insert 段必须含 name: "@dsh-gamecenter/host" 的条目，实际条目名 = ${JSON.stringify(names)}`,
  );
  // 每个包各自只能一条（reconcilePackage :893-896 判的是同一 packageName 命中多个 active source）。
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dup, [], `同一条目名重复登记会触发 reconcilePackage 的 throw：${JSON.stringify(dup)}`);
});

test('发现链其余环节未改坏：dsh.client 与 exports["./client"] 齐全且产物存在', () => {
  assert.equal(clientPkg.private, true, 'Client 必须是 private');
  assert.equal(clientPkg.version, '0.0.0', 'Client 版本必须是 0.0.0');
  assert.equal(clientPkg.dsh?.client?.platform, 'web', 'dsh.client.platform 必须是 web');

  const clientRel = clientPkg.exports?.['./client'];
  const rel = typeof clientRel === 'string' ? clientRel : clientRel?.default;
  assert.ok(typeof rel === 'string', 'exports["./client"].default 必须存在');
  assert.ok(existsSync(path.join(clientRoot, rel)), `${rel} 必须真实存在`);
});
