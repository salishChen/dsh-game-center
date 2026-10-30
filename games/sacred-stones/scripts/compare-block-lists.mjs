#!/usr/bin/env node
// 比较两份压缩块清单，输出**四张表**而不是一张总差集。
//
// 为什么不用 comm：
// - comm 只做相邻比较，两边必须用**同一套排序**；清单是按 offset 数值升序写的，
//   而 `sort` 默认字典序（"10000000" < "999999"），顺序一乱 comm 会静默吐出垃圾差集；
// - comm 只比整行，同一个 offset 两侧字段不同时会被同时算进"两边都有"和"两边都没有"，
//   把"块存在性差异"和"口径差异"混成一张表。
//
// 本脚本按 offset 建索引，输出：
//   1. only-A.txt          只在 A 存在的块
//   2. only-B.txt          只在 B 存在的块
//   3. field-mismatch.txt  两边都有但 (dlen, clen) 不同的块
//   4. summary.json        计数与总量对照
//
// 用法：node scripts/compare-block-lists.mjs <A.txt> <B.txt> [--out <dir>]
// 清单格式：`#` 开头为注释，数据行 `offset<TAB>dlen<TAB>clen`（十进制）。

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';

function parseList(path) {
  if (!existsSync(path)) throw new Error(`找不到清单：${path}`);
  const rows = [];
  const problems = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const text = line.trimEnd();
    if (!text || text.startsWith('#')) return;
    const parts = text.split('\t');
    if (parts.length !== 3) {
      problems.push({line: index + 1, reason: `列数 ${parts.length} 不是 3`, text});
      return;
    }
    const [offset, dlen, clen] = parts.map((p) => Number(p));
    if (!Number.isInteger(offset) || !Number.isInteger(dlen) || !Number.isInteger(clen)) {
      problems.push({line: index + 1, reason: '存在非整数字段', text});
      return;
    }
    if (offset < 0 || dlen <= 0 || clen <= 0) {
      problems.push({line: index + 1, reason: '字段越界（offset>=0, dlen>0, clen>0）', text});
      return;
    }
    rows.push({offset, dlen, clen, line: index + 1});
  });
  const seen = new Map();
  for (const row of rows) {
    const prior = seen.get(row.offset);
    if (prior) {
      problems.push({line: row.line, reason: `offset ${row.offset} 重复（首次出现在第 ${prior.line} 行）`, text: ''});
      continue;
    }
    seen.set(row.offset, row);
  }
  const totals = {rows: seen.size, dlen: 0, clen: 0};
  for (const row of seen.values()) {
    totals.dlen += row.dlen;
    totals.clen += row.clen;
  }
  return {rows: seen, problems, totals, name: basename(path)};
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const outIndex = args.indexOf('--out');
if (positional.length < 2) {
  console.error('用法: node scripts/compare-block-lists.mjs <A.txt> <B.txt> [--out <dir>]');
  process.exit(2);
}
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : resolve('.botharness/block-diff');
const listA = parseList(resolve(positional[0]));
const listB = parseList(resolve(positional[1]));

const onlyA = [];
const onlyB = [];
const mismatch = [];
for (const [offset, rowA] of listA.rows) {
  const rowB = listB.rows.get(offset);
  if (!rowB) {
    onlyA.push(rowA);
    continue;
  }
  if (rowA.dlen !== rowB.dlen || rowA.clen !== rowB.clen) {
    mismatch.push({offset, a: {dlen: rowA.dlen, clen: rowA.clen}, b: {dlen: rowB.dlen, clen: rowB.clen}});
  }
}
for (const [offset, rowB] of listB.rows) {
  if (!listA.rows.has(offset)) onlyB.push(rowB);
}
onlyA.sort((x, y) => x.offset - y.offset);
onlyB.sort((x, y) => x.offset - y.offset);
mismatch.sort((x, y) => x.offset - y.offset);

mkdirSync(outDir, {recursive: true});
const writeRows = (file, rows) =>
  writeFileSync(join(outDir, file), rows.map((r) => `${r.offset}\t${r.dlen}\t${r.clen}`).join('\n') + (rows.length ? '\n' : ''));
writeRows('only-A.txt', onlyA);
writeRows('only-B.txt', onlyB);
writeFileSync(
  join(outDir, 'field-mismatch.txt'),
  mismatch.map((m) => `${m.offset}\tA:${m.a.dlen},${m.a.clen}\tB:${m.b.dlen},${m.b.clen}`).join('\n') +
    (mismatch.length ? '\n' : ''),
);

const summary = {
  a: {name: listA.name, ...listA.totals},
  b: {name: listB.name, ...listB.totals},
  shared: listA.totals.rows - onlyA.length,
  onlyA: onlyA.length,
  onlyB: onlyB.length,
  fieldMismatch: mismatch.length,
  problems: {a: listA.problems, b: listB.problems},
  outDir,
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

if (listA.problems.length > 0 || listB.problems.length > 0) {
  console.error('清单存在问题行，见 summary.json 的 problems 段（这些行未参与比较）');
  process.exitCode = 1;
}
