#!/usr/bin/env node
/**
 * 只读副本的漂移检测（副本 = 第二份真相）+ 刷新转发。
 *
 * ── 判定原则（PM 2026-10-30）───────────────────────────────────────────────
 * **答案必须从 git 对象重算，不能读产地章里记的两个数再互相比。**
 * 只比 `provenance.source_sha256 == provenance.copy_sha256` 是循环验证：两个值都是刷新器写的，
 * 刷新器有 bug 时会同时写错副本、写对章，两边一致、全绿。
 *
 *   recomputed_source = sha256(git show <source.commit>:<source.path>)
 *   recomputed_copy   = sha256(git show <copy.commit>:<copy.path>)
 *   PASS ⇔ recomputed_copy == recomputed_source
 *
 * 产地章的正确形状是**两个锚，各记各的**（源与副本本来就停在不同的提交上）：
 *   { "source": {commit, path, sha256}, "copy": {commit, path, sha256}, ... }
 * 旧形状（顶层扁平 `source_commit` / `source_sha256` / `copy_sha256`）仍能读，但会打一条 note：
 * 单锚让两侧共用一个 commit，而一个 commit 里根本取不到两份 —— 形状本身就是错的。
 * 章里的 sha 是**被验对象**，不是答案；它过期要单独报一类失败，绝不用来代替上面那行。
 *
 * ── 退出码（照 skip-blank 的先例：空集能骗过任何 `>0` 判断）────────────────
 *   0  PASS         两侧从 git 对象重算相等，且产地章与实际相符
 *   1  FAIL         重算不等 / 章过期 / 工作区有未提交改动
 *   2  UNVERIFIABLE 没有 git 历史、或引用的 commit 不在本仓库（浅克隆、导出包、tarball）
 *                  —— 此态**不许静默绿**：验不了就是验不了，不是通过。
 *
 * ── 其它边界 ───────────────────────────────────────────────────────────────
 * - blob 就是入库时的字节 ⇒ **上游侧不需要 LF 规范化**；规范化只用于"比较两份本地文件"。
 *   PNG/dump 这类字节产物一律用原始 sha，禁止规范化。
 * - 工作区脏 ≠ 漂移：先 `git status --porcelain`，脏了报"有未提交改动"，不谈内容差。
 * - 刷新只留**一个写者**：`games/sacred-stones/scripts/refresh-mask-pack-copy.mjs`。
 *   本文件的 `--refresh` 只做转发；目标不存在就**非零退出并指名路径**，不许静默降级成工作区复制。
 * - **刷新器必须幂等**（PM 2026-10-30）：内容相同就不写盘，连时间戳都不写。
 *   一个每次运行都改点东西的工具，会让 `git status` 里的"脏"永久失去信号含义——
 *   你再也无法用"工作区脏"判断"内容变过"。要留"什么时候刷的"，记到提交信息或仓库外日志。
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
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

const git = (args, root = repoRoot) => {
  try {
    return execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'ignore']});
  } catch {
    return null;
  }
};
const gitText = (args, root = repoRoot) => {
  const out = git(args, root);
  return out === null ? null : out.toString('utf8').trim();
};

/** 是不是一个真 git 仓库（tarball / 导出包 / 无 .git 的机器上都为 false）。 */
export const gitAvailable = (root = repoRoot) => Boolean(gitText(['rev-parse', '--git-dir'], root));
/** 该 commit 是否在本仓库（浅克隆里老提交会缺席）。 */
const hasCommit = (rev, root = repoRoot) => gitText(['cat-file', '-e', `${rev}^{commit}`], root) !== null;
/** 该路径最后一次提交（不是 HEAD：源与副本本就停在不同的提交上）。 */
const lastCommitOf = (relPath, root = repoRoot) => gitText(['log', '-1', '--format=%H', '--', relPath], root) || null;
/** 从 git 对象取字节。 */
const blobOf = (rev, relPath, root = repoRoot) => (rev ? git(['show', `${rev}:${relPath}`], root) : null);
/** 有未提交改动（含未跟踪）时返回 status 行，否则 null。 */
const dirtyOf = (relPath, root = repoRoot) => gitText(['status', '--porcelain', '--', relPath], root) || null;

/**
 * 章的锚：优先读新形状的两个锚，回退旧扁平形状（并标注 `shape: 'flat'`）。
 * 旧形状的 `source_commit` 只有源侧，副本侧的 commit 只能现场从 git 查。
 */
export function anchorsOf(prov, pair) {
  if (!prov) return {shape: 'none', source: null, copy: null};
  if (prov.source && prov.copy) {
    return {
      shape: 'two-anchor',
      source: {commit: prov.source.commit ?? null, path: prov.source.path ?? pair.canonical, sha256: prov.source.sha256 ?? null},
      copy: {commit: prov.copy.commit ?? null, path: prov.copy.path ?? pair.copy, sha256: prov.copy.sha256 ?? null},
    };
  }
  return {
    shape: 'flat',
    source: {commit: prov.source_commit ?? null, path: pair.canonical, sha256: prov.source_sha256 ?? null},
    copy: {commit: null, path: pair.copy, sha256: prov.copy_sha256 ?? null},
  };
}

/**
 * 单锚形状的处置开关（PM 2026-10-30 裁决：**不许长期并存**）。
 *   - 默认 `note`：写入器还没升级，报一条提示，不拦。
 *   - `--require-two-anchor` / `MASK_PACK_REQUIRE_TWO_ANCHOR=1`：直接把 flat 判成 FAIL。
 * 迁移纪律：写入器已升到 `format_version: 2`（`bdbc40a` 之后那一版），所以此处**同批次收口**：
 * 单锚形状默认判 FAIL，不留"合法通道"——只要 flat 还能过，就会有人一直用 flat，
 * 而"reader 已经支持双锚"会让人以为迁移完成了。`{strictTwoAnchor: false}` 只给 selftest 用。
 */
export const requireTwoAnchor = () => true;

export function inspect(pair, {root = repoRoot, strictTwoAnchor = requireTwoAnchor()} = {}) {
  const provPath = resolve(root, pair.provenance);
  const prov = existsSync(provPath) ? JSON.parse(readFileSync(provPath, 'utf8')) : null;
  const problems = [];
  const notes = [];
  /** 失败类别决定"修复动作"提示：脏树该 commit，漂移该 refresh —— 混着说会把人引错方向。 */
  const kinds = new Set();

  const anchors = anchorsOf(prov, pair);
  const fail = (kind, msg) => {
    problems.push(msg);
    kinds.add(kind);
  };
  if (anchors.shape === 'flat') {
    if (strictTwoAnchor) {
      fail('flat', '单锚形状已停用：它让两侧共用一个 commit（一个 commit 里取不到两份）。写入器须改为 `{source:{commit,path,sha256}, copy:{…}}`');
    } else {
      notes.push('产地章仍是单锚旧形状（顶层 `source_commit` 让两侧共用）——正确形状是两个锚各记各的');
    }
  }
  if (anchors.shape === 'none') notes.push('没有产地章（只能判"两侧重算是否相等"）');

  // ① 先判"能不能验"：没有 git 历史或 commit 不在仓库里 → UNVERIFIABLE，不是 PASS
  if (!gitAvailable(root)) {
    return {pair, code: 2, verdict: 'unverifiable', problems: ['不在 git 仓库里（无 .git）：无法从 git 对象重算'], notes, kinds: ['unverifiable'], anchors};
  }
  const sourceCommit = anchors.source?.commit ?? lastCommitOf(pair.canonical, root);
  const copyCommit = anchors.copy?.commit ?? lastCommitOf(pair.copy, root);
  const missingCommits = [];
  if (!sourceCommit || !hasCommit(sourceCommit, root)) missingCommits.push(`源 ${sourceCommit ?? '(无)'}`);
  if (!copyCommit || !hasCommit(copyCommit, root)) missingCommits.push(`副本 ${copyCommit ?? '(无)'}`);
  if (missingCommits.length > 0) {
    return {
      pair,
      code: 2,
      verdict: 'unverifiable',
      problems: [`引用的 commit 不在本仓库：${missingCommits.join(' / ')}（浅克隆请 fetch --unshallow；导出包没有 git 历史）`],
      notes,
      kinds: ['unverifiable'],
      anchors,
    };
  }

  const blobSource = blobOf(sourceCommit, pair.canonical, root);
  const blobCopy = blobOf(copyCommit, pair.copy, root);
  if (!blobSource) fail('missing', `commit ${sourceCommit.slice(0, 7)} 里没有 ${pair.canonical}`);
  if (!blobCopy) fail('missing', `commit ${copyCommit.slice(0, 7)} 里没有 ${pair.copy}`);

  // ② 判定：两侧**重算**值必须相等（不读章）
  const recomputedSource = blobSource ? sha(blobSource) : null;
  const recomputedCopy = blobCopy ? sha(blobCopy) : null;
  if (recomputedSource && recomputedCopy && recomputedSource !== recomputedCopy) {
    fail('drift', `重算不一致（漂移）：source ${recomputedSource.slice(0, 12)}… ≠ copy ${recomputedCopy.slice(0, 12)}…`);
  }

  // ③ 章只做对照：过期单独一类失败（有人改了没重刷），但**不作答案**
  if (recomputedSource && anchors.source?.sha256 && anchors.source.sha256 !== recomputedSource) {
    fail('stale', `产地章过期：source.sha256 记 ${anchors.source.sha256.slice(0, 12)}… 而重算为 ${recomputedSource.slice(0, 12)}…（需重跑 --refresh）`);
  }
  if (recomputedCopy && anchors.copy?.sha256 && anchors.copy.sha256 !== recomputedCopy) {
    fail('stale', `产地章过期：copy.sha256 记 ${anchors.copy.sha256.slice(0, 12)}… 而重算为 ${recomputedCopy.slice(0, 12)}…（需重跑 --refresh）`);
  }

  // ④ 工作区脏单独一类：脏 ≠ 漂
  const dSource = dirtyOf(pair.canonical, root);
  const dCopy = dirtyOf(pair.copy, root);
  if (dSource) fail('dirty', `上游工作区有未提交改动（不是漂移，是上游在漂）：${dSource.split('\n')[0]}`);
  if (dCopy) fail('dirty', `副本工作区有未提交改动：${dCopy.split('\n')[0]}`);
  if (anchors.copy?.sha256 && dCopy && existsSync(resolve(root, pair.copy))) {
    const w = readFileSync(resolve(root, pair.copy));
    if (normalizedSha(w) !== anchors.copy.sha256) {
      notes.push('工作区副本的规范化 sha 与章里的 copy.sha256 不同（仅提示：判定用的是 git 对象）');
    }
  }

  return {
    pair,
    code: problems.length === 0 ? 0 : 1,
    verdict: problems.length === 0 ? 'pass' : 'fail',
    problems,
    kinds: [...kinds],
    notes,
    anchors,
    sourceCommit,
    copyCommit,
    recomputedSource,
    recomputedCopy,
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
  const before = {
    copy: existsSync(resolve(repoRoot, pair.copy)) ? sha(readFileSync(resolve(repoRoot, pair.copy))) : null,
    prov: existsSync(resolve(repoRoot, pair.provenance)) ? sha(readFileSync(resolve(repoRoot, pair.provenance))) : null,
  };
  const delegateCommit = lastCommitOf(delegateRel);
  const delegateSha = delegateCommit ? sha(blobOf(delegateCommit, delegateRel)) : sha(readFileSync(delegate));
  const out = execFileSync(process.execPath, [delegate], {cwd: repoRoot, encoding: 'utf8'});
  const after = {
    copy: existsSync(resolve(repoRoot, pair.copy)) ? sha(readFileSync(resolve(repoRoot, pair.copy))) : null,
    prov: existsSync(resolve(repoRoot, pair.provenance)) ? sha(readFileSync(resolve(repoRoot, pair.provenance))) : null,
  };
  // 幂等性观测：内容一个字节没变却仍写了盘（通常只是时间戳）→ 留脏，报出来
  const noopButWrote = before.copy === after.copy && before.prov !== after.prov;
  return {delegateRel, delegateCommit, delegateSha, output: out, noopButWrote};
}

// ── selftest：在夹具上证明"该红的地方会红" ────────────────────────────────
/** 造一个临时 git 仓库：源与副本先一致，再按需要制造漂移。 */
function makeFixture({copyDrift = false, twoAnchor = false, git = true} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drift-fixture-'));
  const pair = PAIRS[0];
  mkdirSync(join(root, 'tools/mask-pack'), {recursive: true});
  mkdirSync(join(root, 'games/sacred-stones/tools'), {recursive: true});
  const body = 'export const CONVENTION = {version: 1, msbFirst: true};\n';
  writeFileSync(join(root, pair.canonical), body);
  writeFileSync(join(root, pair.copy), copyDrift ? body + '// 副本被单独改过\n' : body);
  const g = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: root, stdio: ['ignore', 'pipe', 'ignore']});
  let sourceCommit = null;
  if (git) {
    g(['init', '-q']);
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'fixture']);
    sourceCommit = g(['rev-parse', 'HEAD']).toString('utf8').trim();
  }
  const h = (buf) => createHash('sha256').update(buf).digest('hex');
  const prov = twoAnchor
    ? {
        format_version: 2,
        source: {commit: sourceCommit, path: pair.canonical, sha256: h(Buffer.from(body))},
        copy: {commit: sourceCommit, path: pair.copy, sha256: h(Buffer.from(copyDrift ? body + '// 副本被单独改过\n' : body))},
      }
    : {
        source_commit: sourceCommit,
        source_sha256: h(Buffer.from(body)),
        copy_sha256: h(Buffer.from(copyDrift ? body + '// 副本被单独改过\n' : body)),
      };
  writeFileSync(join(root, pair.provenance), JSON.stringify(prov, null, 2));
  return root;
}

export function selftest() {
  const cases = [];
  const dirs = [];
  const run = (opts, insOpts = {}) => {
    const root = makeFixture(opts);
    dirs.push(root);
    return {root, r: inspect(PAIRS[0], {root, ...insOpts})};
  };

  // ① 两锚 + 两侧一致 → PASS(0)
  {
    const {r} = run({twoAnchor: true});
    cases.push({name: '两锚 + 两侧一致 → PASS exit 0', ok: r.code === 0 && r.verdict === 'pass', detail: `code=${r.code}`});
  }
  // ② 副本被人单独改过且**已提交** → 重算不等 → FAIL(1) 且类别是 drift
  {
    const {r} = run({copyDrift: true, twoAnchor: true});
    cases.push({
      name: '副本已提交地漂移 → FAIL exit 1（类别 drift）',
      ok: r.code === 1 && r.kinds.includes('drift'),
      detail: `code=${r.code} kinds=${r.kinds.join(',')}`,
    });
  }
  // ③ 单锚（默认）→ FAIL(1)，类别 flat：迁移已收口，flat 没有合法通道
  {
    const {r} = run({});
    cases.push({name: '单锚默认 → FAIL exit 1（类别 flat，无合法通道）', ok: r.code === 1 && r.kinds.includes('flat'), detail: `code=${r.code} kinds=${r.kinds.join(',')}`});
  }
  // ④ 单锚 + 显式放宽 → PASS(0)：证明③的红来自形状判据，不是别的东西顺手红
  {
    const {r} = run({}, {strictTwoAnchor: false});
    cases.push({name: '单锚 + 显式放宽 → PASS exit 0（证红来自形状判据）', ok: r.code === 0, detail: `code=${r.code}`});
  }
  // ⑤ 没有 .git → UNVERIFIABLE(2)，不是 PASS
  {
    const {r} = run({git: false});
    cases.push({name: '无 .git → UNVERIFIABLE exit 2（验不了 ≠ 通过）', ok: r.code === 2 && r.verdict === 'unverifiable', detail: `code=${r.code}`});
  }
  // ⑥ 章里记的 sha 与实际不符（章过期）→ FAIL(1)，类别 stale
  {
    const root = makeFixture({twoAnchor: true});
    dirs.push(root);
    const pair = PAIRS[0];
    const provPath = join(root, pair.provenance);
    const prov = JSON.parse(readFileSync(provPath, 'utf8'));
    prov.copy.sha256 = 'f'.repeat(64);
    writeFileSync(provPath, JSON.stringify(prov, null, 2));
    const r = inspect(pair, {root});
    cases.push({name: '章过期（记录 sha 与重算不符）→ FAIL exit 1（类别 stale）', ok: r.code === 1 && r.kinds.includes('stale'), detail: `code=${r.code} kinds=${r.kinds.join(',')}`});
  }

  let bad = 0;
  for (const c of cases) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  [${c.detail}]`);
    if (!c.ok) bad++;
  }
  for (const d of dirs) rmSync(d, {recursive: true, force: true});
  console.log(`\nself-test ${bad === 0 ? 'PASS' : 'FAIL'} (${cases.length} 条)`);
  return bad === 0 ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    process.exit(selftest());
  }
  const doRefresh = argv.includes('--refresh');
  const strictTwoAnchor = requireTwoAnchor(argv);
  if (strictTwoAnchor) console.log('模式：--require-two-anchor（单锚形状判 FAIL）');
  let worst = 0;
  for (const pair of PAIRS) {
    if (doRefresh) {
      try {
        const r = refresh(pair);
        console.log(r.output.trimEnd());
        console.log(`  refreshed 委托 ${r.delegateRel}`);
        console.log(`            写者自身 sha256:${r.delegateSha.slice(0, 16)}…  commit:${(r.delegateCommit ?? '未入库').slice(0, 7)}`);
        if (r.noopButWrote) {
          console.log('            note 内容未变却写了盘（时间戳类写入）：刷新器应当幂等，内容相同就别写');
        }
      } catch (err) {
        console.error(`  FAIL 刷新失败：${err.message}`);
        process.exit(1);
      }
      continue;
    }
    const r = inspect(pair, {strictTwoAnchor});
    const sCommit = (r.sourceCommit ?? r.anchors?.source?.commit ?? '?').slice(0, 7);
    const cCommit = (r.copyCommit ?? r.anchors?.copy?.commit ?? '?').slice(0, 7);
    console.log(`verifying: sha256(git ${sCommit}:${pair.canonical}) ← ${r.recomputedSource ?? '缺失'}`);
    console.log(`        vs sha256(git ${cCommit}:${pair.copy}) ← ${r.recomputedCopy ?? '缺失'}`);
    console.log(
      `recorded in provenance: source ${r.anchors?.source?.sha256?.slice(0, 16) ?? '—'}… / copy ${r.anchors?.copy?.sha256?.slice(0, 16) ?? '—'}…（仅作对照，不参与判定；形状 ${r.anchors?.shape ?? 'none'}）`,
    );
    if (r.verdict === 'pass') {
      console.log('  ok   两侧从 git 对象重算一致，产地章与实际相符');
    } else if (r.verdict === 'unverifiable') {
      console.log('  UNVERIFIABLE（exit 2）：验不了 ≠ 通过');
      for (const p of r.problems) console.log(`       - ${p}`);
      console.log('       CI 上遇到此态应当红；本地浅克隆先 git fetch --unshallow');
    } else {
      console.log('  FAIL');
      for (const p of r.problems) console.log(`       - ${p}`);
      // 修复动作按类别给：脏树该先提交，漂移/章过期才该刷新。给错方向比不给更坏。
      if (r.kinds.includes('dirty')) console.log('       工作区脏时刷新没有意义：先 git add/commit，或还原该文件后再跑');
      if (r.kinds.includes('drift') || r.kinds.includes('stale')) {
        console.log('       一条命令修复：node tools/mask-pack/check-drift.mjs --refresh');
      }
      if (r.kinds.includes('missing')) console.log('       先把上游/副本入库，本检查只认 git 对象');
    }
    for (const n of r.notes) console.log(`       note ${n}`);
    worst = Math.max(worst, r.code);
  }
  if (doRefresh) {
    console.log('\nrefresh OK（副本与产地章已由唯一写者同时更新）');
    return 0;
  }
  if (worst === 2) {
    console.log('\ndrift UNVERIFIABLE (exit 2)');
    process.exit(2);
  }
  if (worst === 1) {
    console.log(`\ndrift FAIL (${PAIRS.length} 对)`);
    process.exit(1);
  }
  console.log(`\ndrift PASS (${PAIRS.length} 对：从 git 对象重算一致)`);
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/tools/mask-pack/check-drift.mjs');
if (invokedDirectly) main();
