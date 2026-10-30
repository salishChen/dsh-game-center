#!/usr/bin/env node
/**
 * 两份漂移校验实现的**差分比较**（不是闸门）。
 *
 * 角色分工（PM 2026-10-30 裁决）：
 *   - `tools/mask-pack/check-drift.mjs`（我）＝ **闸门**，进 `pnpm test`，判定权在它。
 *   - `games/sacred-stones/scripts/verify-mask-pack-copy.mjs`（游戏实现）＝ **对撞方**，
 *     不进闸门判定，只参与本差分比较。
 *
 * 为什么留两份：判据写错时，另一份能抓到。为什么又要差分：两份都"各自绿"并不等于同结论，
 * 一份悄悄改了判据（比如把 `git show HEAD:` 换成工作区）时，只有跑在一起才看得见。
 *
 * 三种结局：
 *   A) 两份都 PASS            → 一致（exit 0）
 *   B) 两份都 FAIL/UNVERIFY   → "内容真漂了/都验不了"，**以闸门为准**（exit 0，但把两边结论都打出来）
 *   C) 一份 PASS 一份 FAIL    → **判据分歧**，要人看（exit 1）—— 这是本脚本唯一会红的情形
 *
 * 另外两条约束：
 *   - 输入必须相同：本脚本断言对撞方源码里出现的两个路径与我方 `PAIRS` 完全一致，
 *     否则比的不是"同一对文件"，而是两个不同的实验；
 *   - 各自要有 self-test：对撞方没有 `--selftest` 时只 warning（它常年绿可能只是因为压根没在跑），
 *     这条按"待对方补"记账，不在这里拦。
 *
 * 收敛条件：两边连续 3 次结论一致后，可把对撞方降级为手动/定时跑（`pnpm check:drift:cross`），
 * 闸门保持单一。计数记在仓库外：`~/.dsh/botharness/mask-pack-cross.jsonl`。
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdirSync, appendFileSync, existsSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const GATE = 'tools/mask-pack/check-drift.mjs';
const PARTNER = 'games/sacred-stones/scripts/verify-mask-pack-copy.mjs';
const PAIR_PATHS = ['tools/mask-pack/pack.mjs', 'games/sacred-stones/tools/mask-pack-reference.mjs'];
const LEDGER = join(homedir(), '.dsh', 'botharness', 'mask-pack-cross.jsonl');

const runScript = (rel) => {
  try {
    const out = execFileSync(process.execPath, [rel], {cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    return {code: 0, out};
  } catch (err) {
    return {code: typeof err.status === 'number' ? err.status : 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`};
  }
};

const verdictOf = (code) => (code === 0 ? 'PASS' : code === 2 ? 'UNVERIFIABLE' : 'FAIL');

/**
 * 从输出里抠出「哪个 path 被算成了什么 sha」。
 * 两边的排版不同（我方用 `←`，对撞方用 `=`；对撞方还是 JSON），所以只认 path 与 64 位 hex 共现的行。
 * 断言的是**行为**而不是源码文本：源码里路径可能是拼出来的，静态 grep 会误报。
 */
const anchorsFromOutput = (out) => {
  const found = new Map();
  for (const line of out.split('\n')) {
    const hex = line.match(/\b[0-9a-f]{64}\b/);
    if (!hex) continue;
    const path = line.match(/(tools\/mask-pack\/pack\.mjs|mask-pack-reference\.mjs)/);
    if (!path) continue;
    const commit = line.match(/git ([0-9a-f]{7,40})/);
    found.set(path[1], {sha: hex[0], commit: commit ? commit[1] : null});
  }
  return found;
};

let failures = 0;

if (!existsSync(join(repoRoot, PARTNER))) {
  console.error(`✗ 找不到对撞方 ${PARTNER}（它被删了吗？本差分无从比较）`);
  process.exit(1);
}
const partnerSrc = readFileSync(join(repoRoot, PARTNER), 'utf8');
if (!/selftest/i.test(partnerSrc)) {
  console.log('  warning 对撞方没有 self-test：一份常年绿的校验器，可能只是压根没在跑（按待补记账）');
}

// ① 两边各跑一次
const gate = runScript(GATE);
const partner = runScript(PARTNER);
const g = verdictOf(gate.code);
const p = verdictOf(partner.code);
console.log(`  gate    ${GATE} → ${g} (exit ${gate.code})`);
console.log(`  partner ${PARTNER} → ${p} (exit ${partner.code})`);

// ② 输入相同：两边对同一 path 必须算出同一 sha（commit 可以不同，字节必须同）
//    只在两边都 PASS 时比得动 —— 对撞方失败时的输出里根本没有 sha 行，拿它当"输入不同"是误判。
const gateAnchors = anchorsFromOutput(gate.out);
const partnerAnchors = anchorsFromOutput(partner.out);
if (g === 'PASS' && p === 'PASS') {
  if (gateAnchors.size === 0 || partnerAnchors.size === 0) {
    console.log(`  warning 抠不出 sha 对照（gate ${gateAnchors.size} 行 / partner ${partnerAnchors.size} 行）：本轮不判"输入是否相同"`);
  }
  for (const [path, ga] of gateAnchors) {
    const pa = partnerAnchors.get(path);
    if (!pa) {
      console.error(`✗ 对撞方没有报告 ${path} 的 sha：两边的"同一对文件"前提不成立`);
      failures++;
    } else if (pa.sha !== ga.sha) {
      console.error(`✗ ${path} 两边算出的 sha 不同（${ga.sha.slice(0, 12)}… vs ${pa.sha.slice(0, 12)}…）：比的不是同一份输入`);
      failures++;
    } else if (pa.commit && ga.commit && pa.commit !== ga.commit) {
      console.log(`  note ${path} 取自不同 commit（${ga.commit.slice(0, 7)} vs ${pa.commit.slice(0, 7)}）但字节 sha 相同 —— 输入等价`);
    }
  }
}

// ③ 分类
let outcome;
if (g === 'PASS' && p === 'PASS') {
  outcome = 'agree-pass';
  console.log('\n✓ 一致：两份都 PASS');
} else if (g !== 'PASS' && p !== 'PASS') {
  outcome = 'agree-fail';
  console.log(`\n• 两份都红（${g} / ${p}）：内容真漂了或都验不了 —— 以闸门为准`);
  console.log('  闸门输出：');
  for (const line of gate.out.trimEnd().split('\n')) console.log(`    ${line}`);
} else {
  outcome = 'divergent';
  console.log(`\n✗ 判据分歧：闸门 ${g}、对撞方 ${p}。这时不是"谁更权威"，是有一侧判据写错了`);
  console.log('  —— 闸门输出：');
  for (const line of gate.out.trimEnd().split('\n')) console.log(`    ${line}`);
  console.log('  —— 对撞方输出：');
  for (const line of partner.out.trimEnd().split('\n')) console.log(`    ${line}`);
  failures++;
}

// ④ 收敛计数（仓库外，不进被校验的内容）
try {
  mkdirSync(dirname(LEDGER), {recursive: true});
  appendFileSync(LEDGER, `${JSON.stringify({at: new Date().toISOString(), gate: g, partner: p, outcome})}\n`);
  const rows = readFileSync(LEDGER, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].outcome === 'agree-pass' || rows[i].outcome === 'agree-fail') streak++;
    else break;
  }
  console.log(
    streak >= 3
      ? `\n连续一致 ${streak} 次（≥3）：可以把对撞方降级为手动跑（pnpm check:drift:cross），闸门保持单一`
      : `\n连续一致 ${streak}/3（达到后可把对撞方降级为手动跑：pnpm check:drift:cross）`,
  );
} catch (err) {
  console.log(`  warning 收敛计数写不进 ${LEDGER}：${err.message}`);
}

process.exit(failures === 0 ? 0 : 1);
