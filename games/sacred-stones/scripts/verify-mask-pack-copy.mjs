/**
 * 校验「只读副本 == 上游」，**答案一律从 git 对象重算**，产地章里的两个 sha 只作对照。
 *
 * 为什么不能只比章里的两个数：那两个值都是刷新器写的。刷新器有 bug 时它会同时把副本写错、
 * 把章写对，两边一致、全绿——那是循环验证。
 *
 * 退出码（照 `skip-blank` 的先例：空集能骗过任何 `>0` 的判断）：
 *   0  PASS          两边从 git 对象重算的结果相等
 *   1  FAIL          重算结果不等 / 副本有未提交改动
 *   2  UNVERIFIABLE  没有 git 历史、或引用的 commit 不存在（CI 应当红，本地请先 fetch --unshallow）
 */
import {readFileSync} from 'node:fs';
import {parseProvenance, ProvenanceShapeError} from '../src/extract/provenance.js';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const PROVENANCE_PATH = join(here, '..', 'tools', 'mask-pack-reference.provenance.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (args) => {
  try {
    return execFileSync('git', args, {cwd: repoRoot, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore']});
  } catch {
    return null;
  }
};
const fail = (code, payload) => {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
};

const rawProvenance = JSON.parse(readFileSync(PROVENANCE_PATH, 'utf8'));
let provenance;
try {
  provenance = parseProvenance(rawProvenance);
} catch (err) {
  if (err instanceof ProvenanceShapeError) {
    fail(1, {status: 'FAIL', code: err.code, reason: err.message, hint: '重跑 scripts/refresh-mask-pack-copy.mjs 生成双锚形状'});
  }
  throw err;
}
// 默认看"现在"（HEAD）；`--as-recorded` 看"当时"（章里记的两个锚）。
// 没有后者，三天前那次为什么是绿的，就再也复算不出来了。
const asRecorded = process.argv.includes('--as-recorded');
const copyRef = asRecorded ? provenance.copy.commit : 'HEAD';

// 0) 有没有 git、引用的 commit 在不在 —— 这就是 UNVERIFIABLE 的判定面
const head = git(['rev-parse', '--verify', 'HEAD']);
if (!head) {
  fail(2, {status: 'UNVERIFIABLE', reason: '没有 git 历史（浅克隆 / 导出包 / 非 git 目录）', hint: 'CI 里应当红；本地请先 git fetch --unshallow'});
}
const sourceCommit = provenance.source.commit;
if (!sourceCommit) fail(2, {status: 'UNVERIFIABLE', reason: '产地章没有 source_commit', hint: '先跑 scripts/refresh-mask-pack-copy.mjs'});

const sourceBlob = git(['show', `${sourceCommit}:${provenance.source.path}`]);
if (!sourceBlob) {
  fail(2, {status: 'UNVERIFIABLE', reason: `commit ${sourceCommit} 里读不到 ${provenance.source.path}`, hint: '该 commit 可能不在本克隆里：git fetch --unshallow'});
}

// 1) 副本必须已提交，且能与上游逐字节比 —— 工作区脏了就先说清楚"副本在漂"
if (asRecorded && !provenance.copy.commit) {
  fail(2, {status: 'UNVERIFIABLE', reason: '产地章没有 copy_commit（副本尚未入库）', hint: '先提交副本，或去掉 --as-recorded 用 HEAD 模式'});
}
const copyDirty = asRecorded ? null : git(['status', '--porcelain', '--', provenance.copy.path]);
if (copyDirty && copyDirty.toString('utf8').trim() !== '') {
  fail(1, {status: 'FAIL', reason: '副本有未提交改动', detail: copyDirty.toString('utf8').trim(), hint: '重跑 scripts/refresh-mask-pack-copy.mjs'});
}
const copyBlob = git(['show', `${copyRef}:${provenance.copy.path}`]);
if (!copyBlob) fail(2, {status: 'UNVERIFIABLE', reason: `${copyRef} 里读不到 ${provenance.copy.path}`});

const recomputedSource = sha256(sourceBlob);
const recomputedCopy = sha256(copyBlob);

const report = {
  verifying: [
    `sha256(git ${sourceCommit.slice(0, 7)}:${provenance.source.path}) = ${recomputedSource}`,
    `sha256(git ${copyRef === 'HEAD' ? 'HEAD' : String(copyRef).slice(0, 7)}:${provenance.copy.path}) = ${recomputedCopy}`,
  ],
  recorded_in_provenance: {
    source_sha256: provenance.source.sha256,
    copy_sha256: provenance.copy.sha256,
    note: '仅作对照，不参与判定',
  },
};

if (recomputedSource !== recomputedCopy) {
  fail(1, {...report, status: 'FAIL', reason: '副本与上游内容不同', hint: '重跑 scripts/refresh-mask-pack-copy.mjs（它同时刷新副本与产地章）'});
}

if (provenance.copy.sha256 !== recomputedCopy || provenance.source.sha256 !== recomputedSource) {
  // 内容对、章对不上：说明章过期了。这是"声明"失效，必须修章而不是放过。
  fail(1, {...report, status: 'FAIL', reason: '产地章与 git 对象不符（章过期）', hint: '重跑 scripts/refresh-mask-pack-copy.mjs'});
}

console.log(JSON.stringify({...report, mode: asRecorded ? 'as-recorded' : 'head', status: 'PASS'}, null, 2));
