/**
 * 产地章的**唯一合法形状**：两个锚，各记各的。
 *
 * ```json
 * { "format_version": 2,
 *   "source": { "commit": "…", "path": "tools/mask-pack/pack.mjs", "sha256": "…" },
 *   "copy":   { "commit": "…", "path": "games/sacred-stones/tools/mask-pack-reference.mjs", "sha256": "…" } }
 * ```
 *
 * 为什么不再接受扁平单锚（`source_commit` + `source_sha256` + `copy_sha256`）：
 * 源与副本分别停在**不同**的 commit 上（源在 `8a1cc43`、副本在它自己被提交的那次），
 * 一个 commit 里根本取不到两份内容——共用 `source_commit` 是形状本身就错，不是"少写一个字段"。
 *
 * 因此扁平形状一律判失败、不做兼容读取：只要 flat 还能过，就会有人一直用 flat，
 * 而"reader 已经支持双锚"会让人误以为迁移完成了。
 */

export class ProvenanceShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvenanceShapeError';
    this.code = 'PROVENANCE_SHAPE';
  }
}

const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function anchorOf(raw, side) {
  const anchor = raw?.[side];
  if (!anchor || typeof anchor !== 'object') {
    throw new ProvenanceShapeError(`产地章缺少 ${side} 锚（期望 {commit,path,sha256}）`);
  }
  const {commit, path, sha256} = anchor;
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new ProvenanceShapeError(`${side}.commit 不是合法的 commit sha：${String(commit)}`);
  }
  if (typeof path !== 'string' || path === '') {
    throw new ProvenanceShapeError(`${side}.path 为空`);
  }
  if (!isHex64(sha256)) {
    throw new ProvenanceShapeError(`${side}.sha256 不是 64 位小写十六进制：${String(sha256)}`);
  }
  return {commit, path, sha256};
}

/** 解析产地章；形状不对直接抛，不做"尽力而为"的兼容。 */
export function parseProvenance(raw) {
  if (!raw || typeof raw !== 'object') throw new ProvenanceShapeError('产地章不是对象');
  if (raw.format_version !== 2) {
    const flat = 'source_commit' in raw || 'copy_sha256' in raw;
    throw new ProvenanceShapeError(
      flat
        ? '单锚形状已停用：它让两侧共用一个 commit，而源与副本分别停在不同 commit 上。请重跑 scripts/refresh-mask-pack-copy.mjs'
        : `产地章 format_version 必须是 2，收到 ${String(raw.format_version)}`,
    );
  }
  return {formatVersion: 2, source: anchorOf(raw, 'source'), copy: anchorOf(raw, 'copy'), notes: raw.notes ?? {}};
}
