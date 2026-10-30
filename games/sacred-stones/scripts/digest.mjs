#!/usr/bin/env node
/**
 * 算发布摘要。口径与平台一致（`packages/dsh-gamecenter-catalog/src/install/bundleDigest.ts`）：
 *   1. 只收 `dist/` 下的文件，路径带 `dist/` 前缀
 *   2. 每条 = { path, size, sha256 }，其中 sha256 **带 `sha256:` 前缀**
 *   3. 按 path 的 UTF-8 字节升序排
 *   4. JSON.stringify（无空格）得到字符串 S
 *   5. bundleDigest = "sha256:" + sha256(S)
 *
 * 另外给两个便于人工核对的数：manifestDigest（只算 index.html + style.css）与 totalBytes。
 *
 * 用法：node scripts/digest.mjs [--json]
 */
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const distRoot = join(pkgRoot, 'dist');

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** 收集 dist/ 下所有文件，返回契约口径的条目数组（已排序）。 */
export function collectDistEntries(distDirectory = distRoot) {
  const entries = walk(distDirectory).map((full) => {
    const bytes = readFileSync(full);
    const path = relative(pkgRoot, full).split(sep).join('/');
    return {path, size: bytes.length, sha256: `sha256:${sha256Hex(bytes)}`};
  });
  // 契约要求按 path 升序；用字节序比较，避免 localeCompare 的平台差异
  entries.sort((a, b) => (Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))));
  return entries;
}

/** 由条目数组算 bundleDigest（契约口径）。 */
export function bundleDigestOf(entries) {
  const canonical = JSON.stringify(entries.map(({path, size, sha256}) => ({path, size, sha256})));
  return `sha256:${sha256Hex(Buffer.from(canonical, 'utf8'))}`;
}

/** 只算 index.html + style.css 的清单摘要（平台安装记录里的 manifestDigest 语义）。 */
export function manifestDigestOf(entries) {
  const picked = entries.filter((e) => e.path === 'dist/index.html' || e.path === 'dist/style.css');
  const canonical = JSON.stringify(picked.map(({path, size, sha256}) => ({path, size, sha256})));
  return {manifestDigest: `sha256:${sha256Hex(Buffer.from(canonical, 'utf8'))}`, count: picked.length};
}

function main() {
  const entries = collectDistEntries();
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  const report = {
    gameId: 'example.sacred-stones',
    files: entries,
    totalBytes,
    bundleDigest: bundleDigestOf(entries),
    ...manifestDigestOf(entries),
  };
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const e of entries) {
    process.stdout.write(`${e.sha256.replace('sha256:', '')}  ${String(e.size).padStart(9)}  ${e.path}\n`);
  }
  process.stdout.write(`\ntotalBytes    : ${totalBytes}\n`);
  process.stdout.write(`bundleDigest  : ${report.bundleDigest}\n`);
  process.stdout.write(`manifestDigest: ${report.manifestDigest}\n`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
