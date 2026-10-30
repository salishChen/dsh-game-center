#!/usr/bin/env node
// check-index.mjs — 判据索引的**完整性自证**
//
// 为什么需要它（PM 2026-10-30）：
//   靠人维护的表会因为"漏加"而失效，而漏加**不会报错**。这跟"写了但没人跑过"是同一种沉默。
//   所以让"新加了一个判据脚本却没进表"当场变红，而不是半年后有人在 grep 里翻出一个没人跑过的脚本。
//
// 规则：
//   1. 扫描 tools/**、games/sacred-stones/tools/**、games/sacred-stones/scripts/** 下的脚本
//      （.mjs / .js / .py / .sh）。
//   2. 每个脚本的文件名必须出现在 docs/criteria-index.md 的**表格正文**里；
//      或者是「## 排除清单」一节里显式列出的（必须附原因）。
//   3. 任何一条不满足 → 非零退出。
//
// **扫描范围本身也要能被证伪**（PM 2026-10-30 追加）：
//   "0 遗漏"只证明"扫到的东西都登记了"，不证明"该被扫到的东西都被扫到了"——
//   扫描范围漏掉一个目录，输出同样是 0 遗漏、同样绿。
//   所以本脚本自带 `--selftest`：在临时目录里造 4 种现场，逐条断言退出码。
//
// 用法：
//   node tools/criteria-index/check-index.mjs              # 检查仓库
//   node tools/criteria-index/check-index.mjs --selftest   # 反例测试自己（必须能红）
//   node tools/criteria-index/check-index.mjs --root <dir> # 对指定根目录检查（selftest 用）
// 退出码：0 全部登记；1 有未登记/排除项无原因；2 索引文件或扫描目录读不到。

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF_ABS = fileURLToPath(import.meta.url);
const INDEX = 'docs/criteria-index.md';
const SCAN_DIRS = ['tools', 'games/sacred-stones/tools', 'games/sacred-stones/scripts'];
const EXTS = ['.mjs', '.js', '.py', '.sh'];

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(root, full, out);
    else if (EXTS.some((x) => e.name.endsWith(x))) out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

/** 「## 排除清单」一节：每行 `- script.mjs — 原因`；**没有原因的不算排除**（会落回未登记）。 */
function parseExcluded(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*排除清单/.test(l));
  if (start < 0) return new Map();
  const out = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s*`?([^\s`]+)`?\s*[—]{1,}\s*(.*)$/);
    if (!m) continue;
    const reason = (m[2] || '').trim();
    if (!reason) continue; // 没原因 = 不算排除，别让空原因混过去
    out.set(m[1].replace(/`/g, ''), reason);
  }
  return out;
}

/** 表格正文 = 到「## 排除清单」之前；只有出现在表格里才算"登记"。 */
function tableBody(markdown) {
  const lines = markdown.split(/\r?\n/);
  const stop = lines.findIndex((l) => /^##\s*排除清单/.test(l));
  return lines.slice(0, stop < 0 ? lines.length : stop).join('\n');
}

/** 纯函数式检查：返回 {code, lines, missing, excludedHit}，不直接退出进程（selftest 要复用）。 */
export function runCheck(root, { indexRel = INDEX } = {}) {
  const lines = [];
  let markdown;
  try {
    markdown = readFileSync(join(root, indexRel), 'utf8');
  } catch (err) {
    return { code: 2, lines: [`✗ 读不到 ${indexRel}：${err.message}`], missing: [], excludedHit: [] };
  }
  const excluded = parseExcluded(markdown);
  const scripts = [];
  let dirsSeen = 0;
  for (const dir of SCAN_DIRS) {
    const found = walk(root, join(root, dir), []);
    if (found.length > 0) dirsSeen++;
    scripts.push(...found);
  }
  // 扫描范围失效必须显式失败：一个都没扫到 ≠ 全部登记
  if (scripts.length === 0) {
    return {
      code: 2,
      lines: [`✗ 三个扫描目录里一个脚本都没有，路径可能不对：${SCAN_DIRS.join(', ')}`],
      missing: [],
      excludedHit: [],
    };
  }

  const selfRel = relative(root, SELF_ABS).split('\\').join('/');
  const table = tableBody(markdown);
  const missing = [];
  const excludedHit = [];
  for (const rel of scripts.sort()) {
    if (rel === selfRel || rel === 'tools/criteria-index/check-index.mjs') continue;
    const name = basename(rel);
    if (table.includes(name)) continue;
    if (excluded.has(name) || excluded.has(rel)) {
      excludedHit.push(rel);
      continue;
    }
    missing.push(rel);
  }

  lines.push(`扫描目录: ${SCAN_DIRS.join(', ')}（命中 ${dirsSeen}/${SCAN_DIRS.length}）`);
  lines.push(`脚本总数: ${scripts.length}（含自检器本身 1 个）`);
  lines.push(`已登记:   ${scripts.length - 1 - excludedHit.length - missing.length}`);
  lines.push(`显式排除: ${excludedHit.length}`);
  for (const rel of excludedHit) lines.push(`  - ${rel}`);
  if (missing.length > 0) {
    lines.push(`✗ ${missing.length} 个脚本既没进表、也不在排除清单里：`);
    for (const rel of missing) lines.push(`  - ${rel}`);
    lines.push('处理方式（二选一，都要写进 docs/criteria-index.md）：');
    lines.push('  ① 加一行：| 判据 | `脚本名` | 输入 | 期望值 | 最近运行 | 状态 |');
    lines.push('  ② 加进「## 排除清单」并写原因：- 脚本名 — 原因');
    return { code: 1, lines, missing, excludedHit };
  }
  lines.push('✓ 每个判据脚本都在表里或排除清单里');
  return { code: 0, lines, missing, excludedHit };
}

// ── selftest：证明这个检查器自己能红 ────────────────────────────────────────
const TABLE_HEAD =
  '| 判据 | 脚本 | 输入 | 期望值 | 最近运行 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n';

function makeSandbox({ tableRows = [], excluded = [], extraScripts = ['tools/unregistered.mjs'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-index-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (const s of ['tools/a.mjs', ...extraScripts]) {
    mkdirSync(join(root, s, '..'), { recursive: true });
    writeFileSync(join(root, s), '// fixture\n');
  }
  let md = '# 判据索引（fixture）\n\n' + TABLE_HEAD;
  for (const r of tableRows) md += r + '\n';
  md += '\n## 排除清单（不属当前判据）\n\n';
  for (const e of excluded) md += `- ${e}\n`;
  writeFileSync(join(root, 'docs/criteria-index.md'), md);
  return root;
}

function selftest() {
  const cases = [];
  const tmpDirs = [];
  const run = (opts) => {
    const root = makeSandbox(opts);
    tmpDirs.push(root);
    return runCheck(root);
  };

  // ① 未登记脚本必须红，且要指名它
  {
    const r = run({ tableRows: ['| 甲 | `a.mjs` | — | — | — | — |'] });
    cases.push({
      name: '未登记脚本 → exit 1 且点名',
      ok: r.code === 1 && r.missing.includes('tools/unregistered.mjs') && r.lines.some((l) => l.includes('unregistered.mjs')),
      detail: `code=${r.code} missing=${r.missing.join(',')}`,
    });
  }
  // ② 全部登记 → 绿
  {
    const r = run({
      tableRows: ['| 甲 | `a.mjs` | — | — | — | — |', '| 乙 | `unregistered.mjs` | — | — | — | — |'],
      extraScripts: [],
    });
    cases.push({ name: '全部登记 → exit 0', ok: r.code === 0, detail: `code=${r.code}` });
  }
  // ③ 排除项无原因 → 仍算未登记（红）
  {
    const r = run({ tableRows: ['| 甲 | `a.mjs` | — | — | — | — |'], excluded: ['unregistered.mjs —'] });
    cases.push({
      name: '排除项没写原因 → exit 1（空原因不算排除）',
      ok: r.code === 1 && r.missing.includes('tools/unregistered.mjs'),
      detail: `code=${r.code}`,
    });
  }
  // ④ 排除项有原因 → 绿
  {
    const r = run({
      tableRows: ['| 甲 | `a.mjs` | — | — | — | — |'],
      excluded: ['unregistered.mjs — 一次性探针，不是判据'],
    });
    cases.push({ name: '排除项带原因 → exit 0', ok: r.code === 0, detail: `code=${r.code}` });
  }
  // ⑤ 扫描范围失效（目录不存在）→ exit 2，不许静默绿
  {
    const root = mkdtempSync(join(tmpdir(), 'check-index-empty-'));
    tmpDirs.push(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/criteria-index.md'), '# empty\n\n' + TABLE_HEAD);
    const r = runCheck(root);
    cases.push({ name: '扫描目录全空 → exit 2（范围失效不算通过）', ok: r.code === 2, detail: `code=${r.code}` });
  }

  let bad = 0;
  for (const c of cases) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  [${c.detail}]`);
    if (!c.ok) bad++;
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log(`\nself-test ${bad === 0 ? 'PASS' : 'FAIL'} (${cases.length} 条)`);
  return bad === 0 ? 0 : 1;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  process.exit(selftest());
}
const rootIdx = argv.indexOf('--root');
const root = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd();
const res = runCheck(root);
for (const l of res.lines) (res.code === 0 ? console.log : console.error)(l);
process.exit(res.code);
