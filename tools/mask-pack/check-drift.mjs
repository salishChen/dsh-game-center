#!/usr/bin/env node
/**
 * 参照副本漂移检测。
 *
 * 背景：`games/sacred-stones/tools/mask-pack-reference.mjs` 是 `tools/mask-pack/pack.mjs` 的只读副本，
 * 用来让对撞用例不跨目录 import。**副本 = 第二份真相**：我这边一改（哪怕只是加一条守卫），
 * 副本就悄悄变成旧版，而它的用例仍然会绿 —— 绿的是旧行为。
 *
 * 所以：两边 sha256 必须相等，否则 exit 1 并提示重新复制 + 复跑已知答案向量。
 *
 * 用法：node tools/mask-pack/check-drift.mjs
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const PAIRS = [
  {
    canonical: 'tools/mask-pack/pack.mjs',
    copy: 'games/sacred-stones/tools/mask-pack-reference.mjs',
  },
];

export function sha256File(path) {
  return 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function checkDrift(repoRootPath = repoRoot) {
  const results = [];
  for (const pair of PAIRS) {
    const a = resolve(repoRootPath, pair.canonical);
    const b = resolve(repoRootPath, pair.copy);
    if (!existsSync(a) || !existsSync(b)) {
      results.push({...pair, ok: false, reason: `文件不存在: ${!existsSync(a) ? pair.canonical : pair.copy}`});
      continue;
    }
    const shaA = sha256File(a);
    const shaB = sha256File(b);
    results.push({...pair, ok: shaA === shaB, canonicalSha: shaA, copySha: shaB});
  }
  return results;
}

function main() {
  const results = checkDrift();
  let bad = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  ok   ${r.copy} 与 ${r.canonical} 同源（${r.canonicalSha}）`);
    } else {
      bad++;
      console.log(`  FAIL ${r.copy} 已漂移（${r.canonicalSha ?? r.reason} vs ${r.copySha ?? ''}）`);
      console.log(`       重新复制：cp ${r.canonical} ${r.copy}`);
      console.log('       再跑一次 node tools/mask-pack/check-drift.mjs 与 pack.mjs --selftest');
    }
  }
  if (bad) {
    console.log(`\ndrift FAIL (${bad}/${results.length})`);
    process.exit(1);
  }
  console.log(`\ndrift PASS (${results.length} 对同源)`);
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/tools/mask-pack/check-drift.mjs');
if (invokedDirectly) main();
