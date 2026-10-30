// 比较器自身的测试：它要能在"对方清单"到达之前就被证明可用，
// 否则等逆向的文件来了，第一个跑它的脚本本身没人验过。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'compare-block-lists.mjs');

function run(listA, listB, {expectFailure = false} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blockdiff-'));
  const a = join(dir, 'a.txt');
  const b = join(dir, 'b.txt');
  writeFileSync(a, listA);
  writeFileSync(b, listB);
  const out = join(dir, 'out');
  // 坏行时脚本有意非零退出，所以这里不用 execFileSync（它会抛），改 spawnSync 显式判状态
  const result = spawnSync(process.execPath, [script, a, b, '--out', out], {encoding: 'utf8'});
  assert.equal(result.error, undefined, '子进程应能启动');
  if (expectFailure) {
    assert.equal(result.status, 1, '清单有问题行时应非零退出');
  } else {
    assert.equal(result.status, 0, `比较器应成功退出，stderr=${result.stderr}`);
  }
  return {dir, out, summary: JSON.parse(result.stdout), stdout: result.stdout};
}

const HEAD = '# rom_sha256=deadbeef\n# 口径：dlen 精确\n';

test('只在一侧存在的块被分到 only-A / only-B', () => {
  const {out, summary} = run(
    `${HEAD}100\t64\t32\n200\t128\t64\n`,
    `${HEAD}200\t128\t64\n300\t32\t16\n`,
  );
  assert.equal(summary.onlyA, 1);
  assert.equal(summary.onlyB, 1);
  assert.equal(summary.shared, 1);
  assert.equal(readFileSync(join(out, 'only-A.txt'), 'utf8').trim(), '100\t64\t32');
  assert.equal(readFileSync(join(out, 'only-B.txt'), 'utf8').trim(), '300\t32\t16');
});

test('同一 offset 字段不同 -> 进 field-mismatch，不算存在性差异', () => {
  const {out, summary} = run(`${HEAD}500\t1200\t217\n`, `${HEAD}500\t1200\t218\n`);
  assert.equal(summary.onlyA, 0);
  assert.equal(summary.onlyB, 0);
  assert.equal(summary.fieldMismatch, 1);
  assert.equal(summary.shared, 1);
  assert.equal(readFileSync(join(out, 'field-mismatch.txt'), 'utf8').trim(), '500\tA:1200,217\tB:1200,218');
});

test('偏移按数值比较：字典序会骗人的那组（999999 vs 1000000）', () => {
  const {summary} = run(`${HEAD}999999\t64\t32\n1000000\t64\t32\n`, `${HEAD}1000000\t64\t32\n999999\t64\t32\n`);
  assert.equal(summary.onlyA, 0);
  assert.equal(summary.onlyB, 0);
  assert.equal(summary.shared, 2);
  assert.equal(summary.fieldMismatch, 0);
});

test('清单乱序也能比：不假设输入已排序', () => {
  const {summary} = run(`${HEAD}300\t64\t32\n100\t64\t32\n200\t64\t32\n`, `${HEAD}200\t64\t32\n300\t64\t32\n100\t64\t32\n`);
  assert.equal(summary.shared, 3);
  assert.equal(summary.onlyA, 0);
  assert.equal(summary.onlyB, 0);
});

test('总量（dlen/clen 求和）来自各自清单，便于核对总体积差', () => {
  const {summary} = run(`${HEAD}1\t100\t10\n2\t200\t20\n`, `${HEAD}1\t100\t10\n`);
  assert.deepEqual({dlen: summary.a.dlen, clen: summary.a.clen}, {dlen: 300, clen: 30});
  assert.deepEqual({dlen: summary.b.dlen, clen: summary.b.clen}, {dlen: 100, clen: 10});
});

test('坏行不参与比较并报出来（列数不对/非整数/重复 offset）', () => {
  const {summary, out} = run(
    `${HEAD}1\t64\t32\n\n# 注释\n坏行\t64\t32\n2\t64\t32\n2\t99\t99\n`,
    `${HEAD}1\t64\t32\n`,
    {expectFailure: true},
  );
  assert.equal(summary.a.rows, 2, '两个合法 offset（重复的被丢弃）');
  assert.equal(summary.problems.a.length, 2, '一行列数不对 + 一处重复');
  assert.ok(existsSync(join(out, 'summary.json')));
});
