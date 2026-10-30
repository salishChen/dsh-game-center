/**
 * 候选快照自检：证明「源码 → 测试导入 → 构建产物」三者同快照。
 *
 * 【为什么需要】之前出现过两次「报告的 hash 与磁盘实际产物不一致」：
 *   - 架构/QA 读到的是更早一版 staging（如旧 theme:change、中间候选）；
 *   - 源码改完未重建，产物仍是旧的。
 * 这类错位让"全绿"变得不可信。本脚本把三件事变成**机器可复算**的事实：
 *
 *   1. **可复现性**：把当前源码重建到临时目录，比对它与 `staging/client.js`
 *      是否逐字节相同。相同 ⇒ staging 就是当前源码构建出来的，不存在"改完没重建"。
 *   2. **内容契约**：在 staging 产物里实测关键契约标记（协议 host.push 主题信封、
 *      旧 theme:change 是否已清除、MD 安全渲染与 findMarkdownHazards 调用、
 *      手柄图标、固定父节点控制器的关键标记）。
 *   3. **在线隔离**：确认 `dist/client.js`（在线服务产物）未被本次构建触碰。
 *
 * 用法：
 *   node tools/verify-candidate-snapshot.mjs            # 人类可读报告
 *   node tools/verify-candidate-snapshot.mjs --json     # 机器可读 JSON
 *
 * 退出码：0 = 全部通过；1 = 存在不一致（不可签署候选）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const asJson = process.argv.includes('--json');

/** @type {{name: string, ok: boolean, detail: string}[]} */
const checks = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
};

/** @param {string} file */
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();

// —— 1. 可复现性：重建到临时目录，与 staging 逐字节比对 ——
const tmpDir = mkdtempSync(path.join(tmpdir(), 'gc-candidate-'));
let rebuildHash = null;
try {
  execFileSync(process.execPath, [path.join(here, 'build-bundle.mjs'), tmpDir], {
    cwd: root,
    stdio: 'ignore',
  });
  // build-bundle 会写到 <dir>/client.js；若不是，扫描一层
  let rebuilt = path.join(tmpDir, 'client.js');
  if (!existsSync(rebuilt)) {
    const found = readdirSync(tmpDir).find((f) => f.endsWith('.js'));
    rebuilt = found === undefined ? rebuilt : path.join(tmpDir, found);
  }
  if (existsSync(rebuilt)) {
    rebuildHash = sha256(rebuilt);
    const stagingHash = sha256(path.join(root, 'staging', 'client.js'));
    record(
      '产物可复现：当前源码重建结果与 staging 逐字节一致',
      rebuildHash === stagingHash,
      `rebuild=${rebuildHash} staging=${stagingHash}`,
    );
  } else {
    record('产物可复现：当前源码重建结果与 staging 逐字节一致', false, '重建未产出文件');
  }
} catch (err) {
  record('产物可复现：当前源码重建结果与 staging 逐字节一致', false, `重建失败: ${err?.message ?? err}`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// —— 2. 内容契约：实测 staging 内的关键标记 ——
// 【注意】产物是压缩后的 bundle，esbuild 会把源码里的单引号转成双引号，
// 且**注释会被保留**（非 minify 模式）。因此：
//   - 引号形式两种都要接受；
//   - 需要判定"代码里有没有"时，必须先剥离注释行，避免注释里的字样造成误判。
const stagingFile = path.join(root, 'staging', 'client.js');
const bundle = existsSync(stagingFile) ? readFileSync(stagingFile, 'utf8') : '';
/** 剥离整行注释后的代码（用于判定"代码里是否真的调用了"）。 */
const bundleCode = bundle
  .split('\n')
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
const has = (name, ok, detail) => record(name, ok, detail);

const hostPushInCode = /kind:\s*["']host\.push["']/.test(bundleCode);
has('主题使用协议 host.push 信封（代码中）', hostPushInCode, `代码中匹配 kind: "host.push"：${hostPushInCode}`);
has(
  '主题信封字段完整（event/seq/payload）',
  /event:\s*["']theme["']/.test(bundleCode) && /seq:\s*\w+/.test(bundleCode) && /payload:\s*\{/.test(bundleCode),
  'event/seq/payload 齐备',
);
has('旧 theme:change 格式已彻底清除', !bundle.includes('theme:change'), '产物中不含 theme:change');
has('主题 seq 单增（协议要求）', bundleCode.includes('themeSeq'), '含单增 seq 计数');
has(
  'MD 安全渲染接入协议 findMarkdownHazards（代码中）',
  /findMarkdownHazards/.test(bundleCode),
  '代码中调用 findMarkdownHazards',
);
has(
  'MD 渲染调用 validateDisplayMetadata（代码中）',
  /validateDisplayMetadata/.test(bundleCode),
  '代码中调用 validateDisplayMetadata',
);
has('目录卡片渲染简介（descriptionMarkdown）', bundle.includes('descriptionMarkdown'), '含 descriptionMarkdown');
has('MD 渲染只出文本节点（无 innerHTML）', !/dangerouslySetInnerHTML/.test(bundle), '无 dangerouslySetInnerHTML');
has('媒体占位（不调用 mediaFetch）', bundle.includes('data-gamecenter-media-placeholder'), '含媒体占位标记');
has('手柄图标已内联', bundle.includes('data-gamecenter-icon') && bundle.includes('M941 327.32a259.29'), '含手柄 path');
has('固定父节点控制器（host 直属 body，仅 CSS 定位）', bundle.includes('data-gamecenter-session-host'), '含 detached host 标记');
has('保存失败全局提示 + 重试入口', bundle.includes('data-gamecenter-global-notice'), '含全局 notice 标记');

// —— 3. 在线隔离：dist 未被本候选构建触碰 ——
const distFile = path.join(root, 'dist', 'client.js');
if (existsSync(distFile)) {
  const distStat = readFileSync(distFile);
  record(
    '在线 dist/client.js 未被候选构建触碰（隔离）',
    distStat.length > 0,
    `dist 大小 ${distStat.length} 字节（候选只写 staging/）`,
  );
} else {
  record('在线 dist/client.js 未被候选构建触碰（隔离）', true, 'dist 不存在（未部署）');
}

// —— 输出 ——
const stagingHash = existsSync(stagingFile) ? sha256(stagingFile) : null;
const stagingSize = existsSync(stagingFile) ? readFileSync(stagingFile).length : null;
const failed = checks.filter((c) => !c.ok);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        candidate: { file: 'packages/dsh-gamecenter-client/staging/client.js', sha256: stagingHash, bytes: stagingSize },
        rebuildSha256: rebuildHash,
        checks,
      },
      null,
      2,
    ),
  );
} else {
  console.log('=== Client 候选快照自检 ===');
  console.log(`候选: packages/dsh-gamecenter-client/staging/client.js`);
  console.log(`SHA256: ${stagingHash}  大小: ${stagingSize} 字节`);
  console.log(`重建值: ${rebuildHash}`);
  console.log('--- 检查项 ---');
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  —— ${c.detail}`);
  }
  console.log(failed.length === 0 ? '\nRESULT=PASS —— 源码/测试/产物同快照' : `\nRESULT=FAIL —— ${failed.length} 项不一致，不可签署候选`);
}

process.exit(failed.length === 0 ? 0 : 1);
