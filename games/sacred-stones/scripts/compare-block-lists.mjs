#!/usr/bin/env node
// 比较两份压缩块清单，输出**四张表 + 两桶畸形行**，而不是一张总差集。
//
// 为什么不用 comm：
// - comm 只做相邻比较，两边必须用**同一套排序**；清单按 offset 数值升序写，而 `sort`
//   默认字典序（"10000000" < "999999"），顺序一乱 comm 会静默吐出垃圾差集；
// - comm 只比整行，同一个 offset 两侧字段不同时会被同时算进"两边都有"和"两边都没有"，
//   把"块存在性差异"和"口径差异"混成一张表。
//
// 输出：
//   only-A.txt / only-B.txt     只在单侧存在的块（存在性差异）
//   field-mismatch.txt          两边都有但 (dlen,clen) 不同（口径差异）
//   malformed-A.txt/-B.txt      无法解析的行（**不静默丢弃**：解析不了 ≠ 不存在）
//   summary.json                两边计数、总量、头注回声、比较器自身摘要、问题行
//
// 安全闸门：两边头注的 rom_sha256 不一致时**拒绝比较**（退出码 3）。
// 不同 ROM 的两份清单做出来的差集，看起来和"解码器不一致"一模一样，成因却完全不同。
//
// 用法：node scripts/compare-block-lists.mjs <A.txt> <B.txt> [--out <dir>]

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);

function parseList(path) {
  if (!existsSync(path)) throw new Error(`找不到清单：${path}`);
  const raw = readFileSync(path, 'utf8');
  const rows = new Map();
  const malformed = [];
  const header = [];
  let eolWarnings = 0;
  const lines = raw.split('\n');
  let byteOffset = 0;

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const lineByte = byteOffset;
    byteOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 = 换行符本身
    if (line === '') return;
    const crlf = line.endsWith('\r');
    const text = crlf ? line.slice(0, -1) : line;
    if (crlf) eolWarnings += 1; // CRLF 不丢弃数据，但要报：行尾曾经让这个项目翻过车
    if (text.trim() === '') return;

    if (text.startsWith('#')) {
      header.push(text);
      return;
    }
    if (text.includes('#')) {
      malformed.push({line: lineNo, byte: lineByte, reason: '`#` 出现在行中（注释必须在行首）', text});
      return;
    }
    const parts = text.split('\t');
    if (parts.length !== 3) {
      malformed.push({line: lineNo, byte: lineByte, reason: `列数 ${parts.length} 不是 3`, text});
      return;
    }
    const [offset, dlen, clen] = parts.map((p) => Number(p));
    if (![offset, dlen, clen].every((n) => Number.isInteger(n))) {
      malformed.push({line: lineNo, byte: lineByte, reason: '存在非整数字段', text});
      return;
    }
    if (offset < 0 || dlen <= 0 || clen <= 0) {
      malformed.push({line: lineNo, byte: lineByte, reason: '字段越界（offset>=0, dlen>0, clen>0）', text});
      return;
    }
    const prior = rows.get(offset);
    if (prior) {
      malformed.push({line: lineNo, byte: lineByte, reason: `offset ${offset} 重复（首次在第 ${prior.line} 行）`, text});
      return;
    }
    rows.set(offset, {offset, dlen, clen, line: lineNo});
  });

  const totals = {rows: rows.size, dlen: 0, clen: 0};
  for (const row of rows.values()) {
    totals.dlen += row.dlen;
    totals.clen += row.clen;
  }
  const romSha256 = header
    .map((h) => /^#\s*rom_sha256\s*=\s*([0-9a-f]{64})\s*$/i.exec(h))
    .find(Boolean)?.[1]?.toLowerCase() ?? null;
  const generator = header.map((h) => /^#\s*生成器\s*=\s*(.+)$/.exec(h)).find(Boolean)?.[1] ?? null;
  return {
    rows,
    malformed,
    header,
    romSha256,
    generator,
    eolWarnings,
    totals,
    name: basename(path),
    path,
  };
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

const selfDigest = createHash('sha256').update(readFileSync(SELF_PATH)).digest('hex');
const baseSummary = {
  comparator: {path: 'games/sacred-stones/scripts/compare-block-lists.mjs', sha256: `sha256:${selfDigest}`},
  a: {name: listA.name, ...listA.totals, romSha256: listA.romSha256, generator: listA.generator, eolWarnings: listA.eolWarnings},
  b: {name: listB.name, ...listB.totals, romSha256: listB.romSha256, generator: listB.generator, eolWarnings: listB.eolWarnings},
};

// 闸门：ROM 不同就没有可比性。缺 rom_sha256 不算不同（可能是老清单），但要标出来。
if (listA.romSha256 && listB.romSha256 && listA.romSha256 !== listB.romSha256) {
  const refusal = {
    ...baseSummary,
    refused: {
      reason: 'rom_sha256 不一致，拒绝比较',
      a: listA.romSha256,
      b: listB.romSha256,
      nextStep: '确认两份清单是否来自同一份 ROM；不同 ROM 的差集与「解码器不一致」长得一样，无法据此判断实现。',
    },
  };
  mkdirSync(outDir, {recursive: true});
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(refusal, null, 2)}\n`);
  console.error(`拒绝比较：rom_sha256 不一致\n  A=${listA.romSha256}\n  B=${listB.romSha256}`);
  process.exit(3);
}

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
  mismatch.map((m) => `${m.offset}\tA:${m.a.dlen},${m.a.clen}\tB:${m.b.dlen},${m.b.clen}`).join('\n') + (mismatch.length ? '\n' : ''),
);
// 打印**原始行文本与字节偏移**，不只打行号。
// 只报"第 1 行字段名不对"，下一个人的第一反应是"我的导出器坏了"，
// 而实际上坏的是格式（表头没加 `#` 就被当成数据行）。原文一眼看出是哪种错。
const writeMalformed = (file, rows) =>
  writeFileSync(
    join(outDir, file),
    rows
      .map((r) => `line ${r.line} (byte ${r.byte})  ${JSON.stringify(r.text)}  ← ${r.reason}`)
      .join('\n') + (rows.length ? '\n' : ''),
  );
writeMalformed('malformed-A.txt', listA.malformed);
writeMalformed('malformed-B.txt', listB.malformed);

const summary = {
  ...baseSummary,
  shared: listA.totals.rows - onlyA.length,
  onlyA: onlyA.length,
  onlyB: onlyB.length,
  fieldMismatch: mismatch.length,
  malformed: {a: listA.malformed.length, b: listB.malformed.length},
  warnings: [],
  outDir,
};
if (!listA.romSha256 || !listB.romSha256) {
  summary.warnings.push('至少一份清单缺少 rom_sha256 头注，无法确认两边读的是同一份卡带');
}
if (listA.eolWarnings > 0 || listB.eolWarnings > 0) {
  summary.warnings.push(`检测到 CRLF 行：A=${listA.eolWarnings} B=${listB.eolWarnings}（数据已按原样解析，未丢弃）`);
}
if (listA.malformed.length > 0 || listB.malformed.length > 0) {
  summary.warnings.push(
    `存在无法解析的行：A=${listA.malformed.length} B=${listB.malformed.length} → 见 malformed-A/B.txt。` +
      '这些块未参与比较，因此不能被判定为"不存在"。',
  );
}
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

if (summary.warnings.length > 0) {
  for (const w of summary.warnings) console.error(`warn: ${w}`);
}
if (listA.malformed.length > 0 || listB.malformed.length > 0) process.exitCode = 1;
