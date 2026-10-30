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
//   2. 每个脚本的文件名必须出现在 docs/criteria-index.md 里；
//      或者是「## 排除清单」一节里显式列出的（必须附原因）。
//   3. 任何一条不满足 → 非零退出。
//
// 用法：node tools/criteria-index/check-index.mjs
// 退出码：0 全部登记；1 有未登记脚本；2 索引文件/目录读不到。

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = process.cwd();
const INDEX = 'docs/criteria-index.md';
const SCAN_DIRS = ['tools', 'games/sacred-stones/tools', 'games/sacred-stones/scripts'];
const EXTS = ['.mjs', '.js', '.py', '.sh'];
const SELF = 'tools/criteria-index/check-index.mjs';

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (EXTS.some((x) => e.name.endsWith(x))) out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
}

function parseExcluded(markdown) {
  // 「## 排除清单」一节：每行 `- script.mjs — 原因`
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*排除清单/.test(l));
  if (start < 0) return new Map();
  const out = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s*`?([^\s`]+)`?\s*[—]{1,}\s*(.*)$/);
    if (!m) continue;
    out.set(m[1].replace(/`/g, ''), (m[2] || '').trim());
  }
  return out;
}

/** 表格正文 = 从第一个 `## ` 表格节到「## 排除清单」之前；只有出现在表格里才算"登记"。 */
function tableBody(markdown) {
  const lines = markdown.split(/\r?\n/);
  const stop = lines.findIndex((l) => /^##\s*排除清单/.test(l));
  return lines.slice(0, stop < 0 ? lines.length : stop).join('\n');
}

function main() {
  let markdown;
  try {
    markdown = readFileSync(join(ROOT, INDEX), 'utf8');
  } catch (err) {
    console.error(`✗ 读不到 ${INDEX}：${err.message}`);
    process.exit(2);
  }
  const excluded = parseExcluded(markdown);
  const scripts = [];
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir), scripts);
  if (scripts.length === 0) {
    console.error(`✗ 三个扫描目录里一个脚本都没有，路径可能不对：${SCAN_DIRS.join(', ')}`);
    process.exit(2);
  }

  // 只有出现在**表格正文**里才算登记；排除清单不算登记（否则两者混为一谈，
  // 输出会显示"已登记 63、显式排除 0"，而实际上有 30 个是被排除的）。
  const table = tableBody(markdown);
  const missing = [];
  const excludedHit = [];
  for (const rel of scripts.sort()) {
    if (rel === SELF) continue;
    const name = basename(rel);
    if (table.includes(name)) continue;
    if (excluded.has(name) || excluded.has(rel)) {
      excludedHit.push(rel);
      continue;
    }
    missing.push(rel);
  }

  console.log(`扫描目录: ${SCAN_DIRS.join(', ')}`);
  console.log(`脚本总数: ${scripts.length}（含自检器本身 1 个）`);
  console.log(`已登记:   ${scripts.length - 1 - excludedHit.length - missing.length}`);
  console.log(`显式排除: ${excludedHit.length}`);
  for (const rel of excludedHit) console.log(`  - ${rel}`);
  if (missing.length > 0) {
    console.error(`\n✗ ${missing.length} 个脚本既没进表、也不在排除清单里：`);
    for (const rel of missing) console.error(`  - ${rel}`);
    console.error('\n处理方式（二选一，都要写进 docs/criteria-index.md）：');
    console.error('  ① 加一行：| 判据 | `脚本名` | 输入 | 期望值 | 最近运行 | 状态 |');
    console.error('  ② 加进「## 排除清单」并写原因：- 脚本名 — 原因');
    process.exit(1);
  }
  console.log('\n✓ 每个判据脚本都在表里或排除清单里');
}

main();
