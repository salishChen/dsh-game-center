import test from 'node:test';
import assert from 'node:assert/strict';

import {parseProvenance, ProvenanceShapeError} from '../src/extract/provenance.js';

const sha = 'cae1d81d9e32e532e768ef37246839351935e2cf491a83c5e96a1d7e28047045';
const v2 = {
  format_version: 2,
  source: {commit: '8a1cc43e084945a42a1889545648393188b6cc39', path: 'tools/mask-pack/pack.mjs', sha256: sha},
  copy: {commit: 'c7b638c846ee60c08ffa41b634232c8a405b507e', path: 'games/sacred-stones/tools/mask-pack-reference.mjs', sha256: sha},
};

test('双锚形状：两个 commit 各记各的，解析成两个独立锚', () => {
  const parsed = parseProvenance(v2);
  assert.equal(parsed.formatVersion, 2);
  assert.equal(parsed.source.commit, '8a1cc43e084945a42a1889545648393188b6cc39');
  assert.equal(parsed.copy.commit, 'c7b638c846ee60c08ffa41b634232c8a405b507e');
  assert.notEqual(parsed.source.commit, parsed.copy.commit);
});

test('扁平单锚：判失败并说明"两侧不能共用一个 commit"，不做兼容读取', () => {
  assert.throws(
    () => parseProvenance({source_commit: '8a1cc43', source_sha256: sha, copy_sha256: sha}),
    (err) => {
      assert.ok(err instanceof ProvenanceShapeError);
      assert.equal(err.code, 'PROVENANCE_SHAPE');
      assert.match(err.message, /单锚形状已停用/);
      assert.match(err.message, /共用一个 commit/);
      return true;
    },
  );
});

test('锚里字段缺失或格式不对：点名是哪一侧、哪个字段', () => {
  assert.throws(() => parseProvenance({format_version: 2, source: v2.source}), /缺少 copy 锚/);
  assert.throws(() => parseProvenance({format_version: 2, source: {...v2.source, sha256: 'ABC'}, copy: v2.copy}), /source\.sha256/);
  assert.throws(() => parseProvenance({format_version: 2, source: {...v2.source, path: ''}, copy: v2.copy}), /source\.path 为空/);
  assert.throws(() => parseProvenance({format_version: 1}), /format_version 必须是 2/);
});
