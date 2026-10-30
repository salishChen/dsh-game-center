/**
 * 一条命令刷新「只读副本 + 产地章」，**字节一律从 git 对象取**。
 *
 * 为什么不用工作区文件：
 *   - 工作区可能处于「改了没提交」的第三种状态，这时副本既不是旧版也不是新版，
 *     而两边校验都会绿；
 *   - 只有从 commit 取字节，任何一台只 clone 了仓库的机器都能独立复算产地章。
 *
 * 用法：node scripts/refresh-mask-pack-copy.mjs
 *
 * 顺序固定：判脏 → 从 commit 读上游字节 → 复制 → 同一次写产地章。
 * 边界：**LF 规范化只用于比较两份源码文本**；PNG、dump 这类字节产物一律用原始 sha。
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const SOURCE = 'tools/mask-pack/pack.mjs';
const COPY = 'games/sacred-stones/tools/mask-pack-reference.mjs';
const PROVENANCE = 'games/sacred-stones/tools/mask-pack-reference.provenance.json';

const git = (args, {allowFail = false} = {}) => {
  try {
    return execFileSync('git', args, {cwd: repoRoot, encoding: 'buffer'});
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
};
const gitText = (args, opts) => {
  const out = git(args, opts);
  return out === null ? null : out.toString('utf8').trim();
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const normalized = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const show = (commit, path) => git(['show', `${commit}:${path}`], {allowFail: true});

// 1) 上游必须已入库：未入库就没有可引用的字节，也谈不上"只凭仓库复算"。
const sourceCommit = gitText(['log', '-1', '--format=%H', '--', SOURCE], {allowFail: true}) || null;
if (!sourceCommit) {
  throw new Error(`上游 ${SOURCE} 尚未入库：没有 commit 就没有可验证的字节。先让它入库，再刷新副本。`);
}

// 2) 先判脏：脏了是"上游在漂"，不是"副本漂移"，必须分开报。
const dirty = gitText(['status', '--porcelain', '--', SOURCE], {allowFail: true}) ?? '';
if (dirty.trim() !== '') {
  throw new Error(`上游 ${SOURCE} 有未提交改动（${dirty.trim()}）。先提交或还原，再从 commit 刷新副本——否则副本会变成第三种内容。`);
}

// 3) 从 commit 取字节，不碰工作区。
const sourceBytes = show(sourceCommit, SOURCE);
if (!sourceBytes) throw new Error(`无法从 ${sourceCommit} 读取 ${SOURCE}`);

writeFileSync(join(repoRoot, COPY), sourceBytes);
const copyBytes = readFileSync(join(repoRoot, COPY));
if (sha256(copyBytes) !== sha256(sourceBytes)) {
  throw new Error('副本写入后字节与 commit 中的上游不一致，已中止');
}

const provenance = {
  source_path: SOURCE,
  source_commit: sourceCommit,
  source_state: '已入库；本产地章的全部 sha 都可由 `git show <source_commit>:<path>` 独立复算',
  source_sha256: sha256(sourceBytes),
  source_sha256_lf: sha256(normalized(sourceBytes)),
  copy_path: COPY,
  copy_sha256: sha256(copyBytes),
  copy_sha256_lf: sha256(normalized(copyBytes)),
  verify: {
    source: `git show ${sourceCommit}:${SOURCE} | sha256sum`,
    copy: `git show <本文件所在 commit>:${COPY} | sha256sum`,
  },
  eol_note: '两文件当前逐字节相同。仍记录 LF 规范化 sha，仅用于比较两份源码文本；PNG/dump 等字节产物一律用原始 sha，禁止规范化（规范化会把真实换行差异掩盖成"一致"）。',
  boundary: '刷新副本与重写本文件是同一次动作（本脚本）。手工两步会让副本与产地章对不上，此时唯一合法修法是重跑本脚本，不是放宽断言。',
};
writeFileSync(join(repoRoot, PROVENANCE), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(JSON.stringify({refreshed: true, source_commit: sourceCommit, sha256: provenance.copy_sha256}, null, 2));
