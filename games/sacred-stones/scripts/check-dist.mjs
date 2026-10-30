#!/usr/bin/env node
/**
 * 出包前的硬自检。任何一条不过就以非零码退出，构建即失败。
 *
 * 这些规则来自平台侧的硬约束（见 docs/rom-facts.md 附近与群内契约）：
 *   1. 包里只能有白名单四件：`gamecenter.json` + `dist/{game.js,index.html,style.css}`。
 *      多一个文件不是"冗余"，是**装不上**——客户端只拉这四个路径。
 *   2. `dist/game.js` 必须是单文件 bundle。下载器不解析 `import` 依赖图，
 *      拆成多模块会出现"只拉到一部分、最后报摘要不匹配"的假故障。
 *   3. 素材**绝不内联**进 `game.js`（不放 base64 / data: 大块）。
 *      这是版权纪律，也是唯一能绕过白名单的通道，所以按体积阈值硬挡。
 *   4. `game.js` ≤ 2 MB。超过说明代码或数据进了包，回到第 3 条去查。
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_GAME_JS_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_INLINE_BLOB_CHARS = 4096; // 单块 base64 / data: 超过这个长度就认定是内联素材
const ALLOWED_DIST_FILES = ['game.js', 'index.html', 'style.css'];
const ALLOWED_PACKAGE_FILES = ['gamecenter.json', ...ALLOWED_DIST_FILES.map((f) => `dist/${f}`)];

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const distRoot = join(pkgRoot, 'dist');

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ---- 1. 白名单：dist 下只允许三件 ----
const distFiles = walk(distRoot).map((f) => relative(distRoot, f).split(sep).join('/'));
for (const file of distFiles) {
  if (!ALLOWED_DIST_FILES.includes(file)) fail(`dist/ 下出现白名单外的文件：dist/${file}（客户端不会拉它，装包会缺文件）`);
}
for (const file of ALLOWED_DIST_FILES) {
  if (!distFiles.includes(file)) fail(`dist/ 缺少必要文件：dist/${file}`);
}

// ---- 2. 顶层：只允许 gamecenter.json + dist 三件 ----
const topLevel = readdirSync(pkgRoot).filter((name) => {
  if (name === 'dist') return false;
  const st = statSync(join(pkgRoot, name));
  return st.isFile() && name === 'gamecenter.json';
});
if (!topLevel.includes('gamecenter.json')) fail('缺少 gamecenter.json');

// ---- 3. game.js：体积 / 单文件 / 无内联素材 ----
const gamePath = join(distRoot, 'game.js');
const gameJs = readFileSync(gamePath);
const gameText = gameJs.toString('utf8');

if (gameJs.length > MAX_GAME_JS_BYTES) {
  fail(`dist/game.js 是 ${gameJs.length} B，超过 2 MB 警戒线。先查是不是把素材内联进包里了。`);
}
notes.push(`dist/game.js = ${gameJs.length} B（上限 ${MAX_GAME_JS_BYTES}）`);

// 单文件 bundle：不允许残留模块语法（esbuild bundle 之后不应有顶层 import/export）
const importStmt = /(^|[\n;])\s*import\s+[^(]|(^|[\n;])\s*export\s+(const|let|var|function|class|\{|\*)/m;
if (importStmt.test(gameText)) fail('dist/game.js 里检测到 import/export 语句，说明没打成单文件 bundle');
if (/(^|\n)\s*importScripts\s*\(/.test(gameText)) fail('dist/game.js 使用 importScripts，下载器不会跟随');

// 内联素材：长 base64 / data: URI
const dataUri = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/gi;
const dataHits = gameText.match(dataUri) ?? [];
const longBlobs = dataHits.filter((hit) => hit.length > MAX_INLINE_BLOB_CHARS);
if (longBlobs.length > 0) {
  const largest = Math.max(...longBlobs.map((b) => b.length));
  fail(`dist/game.js 里有 ${longBlobs.length} 块长 base64 data: URI（最大 ${largest} 字符）——素材必须运行时从玩家卡带提取，不许内联`);
}
const base64ish = /["'`][A-Za-z0-9+/]{4096,}={0,2}["'`]/g;
const bareBlobs = gameText.match(base64ish) ?? [];
if (bareBlobs.length > 0) {
  fail(`dist/game.js 里有 ${bareBlobs.length} 段裸 base64 字符串（≥4096 字符）——疑似内联素材`);
}
notes.push(`内联素材检查：data: URI ${dataHits.length} 块，裸 base64 长串 ${bareBlobs.length} 段`);

// ---- 4. index.html 不许引用 dist 之外的脚本 ----
const html = readFileSync(join(distRoot, 'index.html'), 'utf8');
const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
for (const src of scriptSrcs) {
  // index.html 与 game.js 同在 dist/ 下，相对路径就是文件名
  const cleaned = src.replace(/^\.\//, '').replace(/^dist\//, '');
  if (!ALLOWED_DIST_FILES.includes(cleaned)) {
    fail(`dist/index.html 引用了不在白名单内的脚本：${src}（下载器只拉 dist 三件，多引用会 404）`);
  }
}
notes.push(`index.html 引用脚本 ${scriptSrcs.length} 个：${scriptSrcs.join(', ') || '（无）'}`);

// ---- 报告 ----
for (const note of notes) process.stdout.write(`· ${note}\n`);
if (failures.length > 0) {
  process.stderr.write(`\n出包自检失败（${failures.length} 条）：\n`);
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write('\n出包自检通过：白名单四件、单文件 bundle、无内联素材、体积在警戒线内。\n');
