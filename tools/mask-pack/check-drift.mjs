#!/usr/bin/env node
/**
 * 只读副本的漂移检测（副本 = 第二份真相）+ 刷新转发。
 *
 * ── 判定原则（PM 2026-10-30）───────────────────────────────────────────────
 * **答案必须从 git 对象重算，不能读产地章里记的两个数再互相比。**
 * 只比 `provenance.source_sha256 == provenance.copy_sha256` 是循环验证：两个值都是刷新器写的，
 * 刷新器有 bug 时会同时写错副本、写对章，两边一致、全绿。
 *
 *   recomputed_source = sha256(git show <source_commit>:tools/mask-pack/pack.mjs)
 *   recomputed_copy   = sha256(git show <copy_commit>:games/sacred-stones/tools/mask-pack-reference.mjs)
 *   PASS ⇔ recomputed_copy == recomputed_source
 *
 * 产地章里记的 source_sha256 / copy_sha256 是**被验对象**，不是答案：它们的角色是"这份章还诚实吗"，
 * 单独成一条失败类（`产地章过期`），绝不用来代替上面那行。
 *
 * ── 其它边界 ───────────────────────────────────────────────────────────────
 * - blob 就是入库时的字节 ⇒ **上游侧不需要 LF 规范化**；规范化只用于"比较两份本地文件"。
 *   PNG/dump 这类字节产物一律用原始 sha，禁止规范化（本项目刚被换行坑过一次）。
 * - 工作区脏 ≠ 漂移：先 `git status --porcelain`，脏了报"有未提交改动"，不谈内容差 ——
 *   否则"上游改了没提交"会被念成"副本漂移"，而真相是上游在漂。
 * - 刷新只留**一个写者**：`games/sacred-stones/scripts/refresh-mask-pack-copy.mjs`（字节取自 git 对象）。
 *   本文件的 `--refresh` 只做转发；目标不存在就**非零退出并指名路径**，不许静默什么都不做。
 *
 * 用法：
 *   node tools/mask-pack/check-drift.mjs              # 校验（exit 1 = 漂移/章过期/有未提交改动）
 *   node tools/mask-pack/check-drift.mjs --refresh    # 转发给唯一写者刷新副本 + 同一次重写产地章
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const PAIRS = [
  {
    canonical: 'tools/mask-pack/pack.mjs',
    copy: 'games/sacred-stones/tools/mask-pack-reference.mjs',
    provenance: 'games/sacred-stones/tools/mask-pack-reference.provenance.json',
  },
];

/** 唯一写者（刷新器）的默认路径；可用 MASK_PACK_REFRESH_SCRIPT 覆盖（便于测"目标不存在"）。 */
export const REFRESH_SCRIPT_DEFAULT = 'games/sacred-stones/scripts/refresh-mask-pack-copy.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** LF 规范化只对源码文本有意义；对字节产物调用它是错误的，所以单独命名、不参与 blob 判定。 */
const normalizedSha = (buf) => sha(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));

const git = (args) => {
  try {
    return execFileSync('git', args, {cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore']});
  } catch {
    return null;
  }
};
const gitText = (args) => {
  const out = git(args);
  return out === null ? null : out.toString('utf8').trim();
};

/** 该路径最后一次提交（不是 HEAD，允许上游与副本落在不同 commit 里）。 */
const lastCommitOf = (relPath) => gitText(['log', '-1', '--format=%H', '--', relPath]) || null;
/** 从 git 对象取字节：任何一台只 clone 了仓库的机器都能复算。 */
const blobOf = (rev, relPath) => (rev ? git(['show', `${rev}:${relPath}`]) : null);
/** 有未提交改动（含未跟踪）时返回 status 行，否则 null。 */
const dirtyOf = (relPath) => gitText(['status', '--porcelain', '--', relPath]) || null;

export function inspect(pair) {
  const provPath = resolve(repoRoot, pair.provenance);
  const prov = existsSync(provPath) ? JSON.parse(readFileSync(provPath, 'utf8')) : null;
  const problems = [];
  const notes = [];
  /** 失败类别决定"修复动作"提示：脏树该 commit，漂移该 refresh —— 两者混着说会把人引错方向。 */
  const kinds = new Set();

  const sourceCommit = lastCommitOf(pair.canonical);
  const copyCommit = lastCommitOf(pair.copy);
  const blobSource = blobOf(sourceCommit, pair.canonical);
  const blobCopy = blobOf(copyCommit, pair.copy);
  const fail = (kind, msg) => {
    problems.push(msg);
    kinds.add(kind);
  };
  if (!blobSource) fail('missing', `没有上游的 git 对象：${pair.canonical}（先入库才能只凭仓库复算）`);
  if (!blobCopy) fail('missing', `没有副本的 git 对象：${pair.copy}`);

  // ① 判定：两侧**重算**值必须相等（不读章）
  const recomputedSource = blobSource ? sha(blobSource) : null;
  const recomputedCopy = blobCopy ? sha(blobCopy) : null;
  if (recomputedSource && recomputedCopy && recomputedSource !== recomputedCopy) {
    fail(
      'drift',
      `重算不一致（漂移）：source ${recomputedSource.slice(0, 12)}… ≠ copy ${recomputedCopy.slice(0, 12)}…`,
    );
  }

  // ② 章只做对照：它过期了要报，但**不作答案**
  if (prov && recomputedSource && prov.source_sha256 && prov.source_sha256 !== recomputedSource) {
    fail(
      'stale',
      `产地章过期：source_sha256 记 ${prov.source_sha256.slice(0, 12)}… 而重算为 ${recomputedSource.slice(0, 12)}…（需重跑 --refresh）`,
    );
  }
  if (prov && recomputedCopy && prov.copy_sha256 && prov.copy_sha256 !== recomputedCopy) {
    fail(
      'stale',
      `产地章过期：copy_sha256 记 ${prov.copy_sha256.slice(0, 12)}… 而重算为 ${recomputedCopy.slice(0, 12)}…（需重跑 --refresh）`,
    );
  }
  if (!prov) notes.push('没有产地章（只能判"两侧重算是否相等"）');

  // ③ 工作区脏单独一类：脏 ≠ 漂
  const dSource = dirtyOf(pair.canonical);
  const dCopy = dirtyOf(pair.copy);
  if (dSource) fail('dirty', `上游工作区有未提交改动（不是漂移，是上游在漂）：${dSource.split('\n')[0]}`);
  if (dCopy) fail('dirty', `副本工作区有未提交改动：${dCopy.split('\n')[0]}`);
  if (prov && dCopy && existsSync(resolve(repoRoot, pair.copy))) {
    const w = readFileSync(resolve(repoRoot, pair.copy));
    if (normalizedSha(w) !== prov.copy_sha256_lf) {
      notes.push('工作区副本的规范化 sha 与章里的 copy_sha256_lf 不同（仅提示：判定用的是 git 对象）');
    }
  }

  return {
    pair,
    ok: problems.length === 0,
    problems,
    kinds: [...kinds],
    notes,
    sourceCommit,
    copyCommit,
    recomputedSource,
    recomputedCopy,
    recorded: prov ? {source_sha256: prov.source_sha256, copy_sha256: prov.copy_sha256} : null,
  };
}

/** 刷新：只做转发。目标不存在 → 抛错（调用方非零退出并指名路径）。 */
export function refresh(pair) {
  const delegateRel = process.env.MASK_PACK_REFRESH_SCRIPT || REFRESH_SCRIPT_DEFAULT;
  const delegate = resolve(repoRoot, delegateRel);
  if (!existsSync(delegate)) {
    const err = new Error(
      `找不到唯一写者 ${delegateRel}，拒绝用工作区复制顶替（那会把未提交内容烧进产地章）。` +
        `请恢复该脚本，或用 MASK_PACK_REFRESH_SCRIPT 指定路径。`,
    );
    err.code = 'REFRESH_WRITER_MISSING';
    throw err;
  }
  const delegateCommit = lastCommitOf(delegateRel);
  const delegateSha = delegateCommit ? sha(blobOf(delegateCommit, delegateRel)) : sha(readFileSync(delegate));
  const out = execFileSync(process.execPath, [delegate], {cwd: repoRoot, encoding: 'utf8'});
  return {delegateRel, delegateCommit, delegateSha, output: out};
}

function main() {
  const argv = process.argv.slice(2);
  const doRefresh = argv.includes('--refresh');
  let bad = 0;
  for (const pair of PAIRS) {
    if (doRefresh) {
      try {
        const r = refresh(pair);
        console.log(r.output.trimEnd());
        console.log(`  refreshed 委托 ${r.delegateRel}`);
        console.log(`            写者自身 sha256:${r.delegateSha.slice(0, 16)}…  commit:${(r.delegateCommit ?? '未入库').slice(0, 7)}`);
      } catch (err) {
        console.error(`  FAIL 刷新失败：${err.message}`);
        process.exit(1);
      }
      continue;
    }
    const r = inspect(pair);
    console.log(`verifying: sha256(git ${(r.sourceCommit ?? '?').slice(0, 7)}:${r.pair.canonical}) ← ${r.recomputedSource ?? '缺失'}`);
    console.log(
      `        vs sha256(git ${(r.copyCommit ?? '?').slice(0, 7)}:${r.pair.copy}) ← ${r.recomputedCopy ?? '缺失'}`,
    );
    console.log(
      `recorded in provenance: source_sha256 ${r.recorded?.source_sha256?.slice(0, 16) ?? '—'}… / copy_sha256 ${r.recorded?.copy_sha256?.slice(0, 16) ?? '—'}…（仅作对照，不参与判定）`,
    );
    if (r.ok) {
      console.log('  ok   两侧从 git 对象重算一致，产地章与实际相符');
    } else {
      bad++;
      console.log('  FAIL');
      for (const p of r.problems) console.log(`       - ${p}`);
      // 修复动作按类别给：脏树该先提交，漂移/章过期才该刷新。给错方向比不给更坏。
      if (r.kinds.includes('dirty')) {
        console.log('       工作区脏时刷新没有意义：先 git add/commit，或还原该文件后再跑');
      }
      if (r.kinds.includes('drift') || r.kinds.includes('stale')) {
        console.log('       一条命令修复：node tools/mask-pack/check-drift.mjs --refresh');
      }
      if (r.kinds.includes('missing')) {
        console.log('       先把上游/副本入库，本检查只认 git 对象');
      }
    }
    for (const n of r.notes) console.log(`       note ${n}`);
  }
  if (doRefresh) {
    console.log('\nrefresh OK（副本与产地章已由唯一写者同时更新）');
    return 0;
  }
  if (bad) {
    console.log(`\ndrift FAIL (${bad}/${PAIRS.length})`);
    process.exit(1);
  }
  console.log(`\ndrift PASS (${PAIRS.length} 对：从 git 对象重算一致)`);
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/tools/mask-pack/check-drift.mjs');
if (invokedDirectly) main();
