/**
 * 装配声明守卫（证据分栏：STATIC）。
 *
 * 【本测试要拦住的缺陷】
 * `package.json` 的 `exports["."].types` 曾指向 `./src/types/index.d.ts`，
 * 那是**浏览器半**的声明。Host 半 `lib/index.js` 导出的是 `name` / `apply` / `default`，
 * 于是任何 Host 侧 `import { name } from '@dsh-gamecenter/client'` 都会报
 * `TS2305: ... has no exported member 'name'`（不是 TS2307 —— 模块解析是通的，
 * 是声明与运行时导出不匹配）。
 *
 * 【为什么用真实 tsc 而不是文本匹配】
 * 文本匹配只能证明"文件里有某个字符串"，不能证明"TypeScript 能解析出这个导出"。
 * 本测试用 `test/fixtures/host-half-types.ts` 对本包做真实具名/默认导入并跑 `tsc`，
 * 导入失败会以非零退出码报出来。另有负例（把 types 指回浏览器半）证明本守卫真会红。
 *
 * 运行：node --test test/host-half-types.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const fixture = path.join(here, 'fixtures', 'host-half-types.ts');

const TSC_ARGS = [
  '--strict',
  '--noEmit',
  '--target', 'ES2022',
  '--module', 'nodenext',
  '--moduleResolution', 'nodenext',
  '--skipLibCheck',
];

/** 找 tsc：包内优先，其次仓库根。 */
function findTsc() {
  const candidates = [
    path.join(pkgRoot, 'node_modules', '.bin', 'tsc'),
    path.join(pkgRoot, '..', '..', 'node_modules', '.bin', 'tsc'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** 跑一次 tsc，返回 { exitCode, output }。 */
function runTsc(file, cwd = pkgRoot) {
  const tsc = findTsc();
  assert.ok(tsc !== undefined, '找不到 tsc 可执行文件（包内与仓库根都没有）');
  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(tsc, [...TSC_ARGS, file], {
      encoding: 'utf8',
      stdio: 'pipe',
      // Windows 上 .bin/tsc 是 .cmd，必须经 shell 调用。
      shell: process.platform === 'win32',
      cwd,
    });
  } catch (error) {
    const failure = /** @type {{stdout?: string, stderr?: string, status?: number}} */ (error);
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    exitCode = failure.status ?? 1;
  }
  return { exitCode, output };
}

test('exports["."].types 指向 Host 半自己的声明，且与浏览器半的声明不是同一个文件', () => {
  const hostTypes = pkg.exports?.['.']?.types;
  const browserTypes = pkg.exports?.['./client']?.types;

  assert.equal(hostTypes, './lib/index.d.ts', 'exports["."].types 必须指向 Host 半声明');
  assert.equal(browserTypes, './src/types/index.d.ts', 'exports["./client"].types 必须指向浏览器半声明');
  assert.notEqual(hostTypes, browserTypes, '两半的声明文件不得是同一个（这正是本次缺陷）');

  for (const rel of [hostTypes, browserTypes]) {
    assert.ok(existsSync(path.join(pkgRoot, rel)), `${rel} 必须真实存在`);
  }
  // 两半的默认导出也必须指向不同的产物文件。
  assert.notEqual(
    pkg.exports?.['.']?.default,
    pkg.exports?.['./client']?.default,
    '两半的 default 不得指向同一产物',
  );
  // files 白名单必须包含 Host 半声明，否则打包后会丢声明。
  assert.ok(pkg.files?.includes('lib/index.d.ts'), 'files 必须含 lib/index.d.ts');
});

test('Host 半声明覆盖 lib/index.js 的运行时导出，且不混入浏览器半的导出名', async () => {
  // 运行时真值：直接 import 产物，取真实导出键。
  const mod = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'index.js')).href);
  const runtimeKeys = new Set(Object.keys(mod));
  assert.ok(runtimeKeys.has('default'), 'lib/index.js 必须有默认导出');

  const decl = readFileSync(path.join(pkgRoot, 'lib', 'index.d.ts'), 'utf8');
  const declared = new Set(
    [
      ...decl.matchAll(/export\s+(?:declare\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g),
    ].map((m) => m[1]),
  );

  // 浏览器半的导出名不得出现在 Host 半声明里（否则又是两半混淆）。
  for (const browserOnly of ['LOCALE_NS', 'PANEL_ID', 'ClientContext', 'PauseResult']) {
    assert.equal(declared.has(browserOnly), false, `Host 半声明不应导出浏览器半的 ${browserOnly}`);
  }
  for (const key of runtimeKeys) {
    if (key === 'default') continue;
    assert.ok(declared.has(key), `runtime 导出了 ${key}，但 lib/index.d.ts 没有声明它`);
  }
});

test('真实 tsc：Host 侧具名与默认导入必须编译通过（exit 0）', () => {
  assert.ok(existsSync(fixture), `守卫夹具缺失：${fixture}`);
  const { exitCode, output } = runTsc(fixture);
  assert.equal(exitCode, 0, `Host 半具名/默认导入编译失败（exit ${exitCode}）：\n${output}`);
});

test('负例：把 types 指回浏览器半后，tsc 必须报 TS2305（证明本守卫真会红）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gc-host-half-'));
  try {
    // 造一个"错的包"：types 指回浏览器半声明，产物仍是 Host 半。
    const badPkgDir = path.join(tmp, 'node_modules', '@dsh-gamecenter', 'client');
    mkdirSync(path.join(badPkgDir, 'lib'), { recursive: true });
    mkdirSync(path.join(badPkgDir, 'src', 'types'), { recursive: true });
    copyFileSync(path.join(pkgRoot, 'lib', 'index.js'), path.join(badPkgDir, 'lib', 'index.js'));
    writeFileSync(
      path.join(badPkgDir, 'package.json'),
      JSON.stringify({
        name: '@dsh-gamecenter/client',
        version: '0.0.0',
        type: 'module',
        main: 'lib/index.js',
        exports: { '.': { types: './src/types/index.d.ts', default: './lib/index.js' } },
      }),
    );
    // 浏览器半声明：没有 name、没有 default。
    writeFileSync(
      path.join(badPkgDir, 'src', 'types', 'index.d.ts'),
      'export function apply(ctx: { slots: unknown }): void;\nexport const PANEL_ID: "gamecenter";\n',
    );
    // 让 fixture 里的 `type: module` 语义与包内一致。
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    const badFixture = path.join(tmp, 'bad.ts');
    copyFileSync(fixture, badFixture);

    const { exitCode, output } = runTsc(badFixture, tmp);
    assert.notEqual(exitCode, 0, '把 types 指向浏览器半后 tsc 竟然通过，说明此守卫形同虚设');
    const ts2305 = (output.match(/TS2305/g) ?? []).length;
    assert.ok(ts2305 >= 1, `期望至少一条 TS2305（缺少 name 导出），实际输出：\n${output}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
