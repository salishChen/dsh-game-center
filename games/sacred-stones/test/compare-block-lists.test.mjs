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

const ROM_A = 'a'.repeat(64);
const ROM_B = 'b'.repeat(64);
const head = (rom = ROM_A) => `# rom_sha256=${rom}\n# 生成器=test\n# 口径：dlen 精确\n`;

function run(listA, listB, {expectStatus = 0} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blockdiff-'));
  const a = join(dir, 'a.txt');
  const b = join(dir, 'b.txt');
  writeFileSync(a, listA);
  writeFileSync(b, listB);
  const out = join(dir, 'out');
  // 坏行/拒绝比较时脚本有意非零退出，所以不用 execFileSync（会抛）
  const result = spawnSync(process.execPath, [script, a, b, '--out', out], {encoding: 'utf8'});
  assert.equal(result.error, undefined, '子进程应能启动');
  assert.equal(result.status, expectStatus, `stderr=${result.stderr}`);
  const summaryPath = join(out, 'summary.json');
  assert.ok(existsSync(summaryPath), '无论成功与否都应写 summary.json');
  return {dir, out, summary: JSON.parse(readFileSync(summaryPath, 'utf8')), result};
}

test('只在一侧存在的块被分到 only-A / only-B', () => {
  const {out, summary} = run(`${head()}100\t64\t32\n200\t128\t64\n`, `${head()}200\t128\t64\n300\t32\t16\n`);
  assert.equal(summary.onlyA, 1);
  assert.equal(summary.onlyB, 1);
  assert.equal(summary.shared, 1);
  assert.equal(readFileSync(join(out, 'only-A.txt'), 'utf8').trim(), '100\t64\t32');
  assert.equal(readFileSync(join(out, 'only-B.txt'), 'utf8').trim(), '300\t32\t16');
});

test('同一 offset 字段不同 -> 进 field-mismatch，不算存在性差异', () => {
  const {out, summary} = run(`${head()}500\t1200\t217\n`, `${head()}500\t1200\t218\n`);
  assert.equal(summary.onlyA, 0);
  assert.equal(summary.onlyB, 0);
  assert.equal(summary.fieldMismatch, 1);
  assert.equal(readFileSync(join(out, 'field-mismatch.txt'), 'utf8').trim(), '500\tA:1200,217\tB:1200,218');
});

test('偏移按数值比较：字典序会骗人的那组（999999 vs 1000000）', () => {
  const {summary} = run(`${head()}999999\t64\t32\n1000000\t64\t32\n`, `${head()}1000000\t64\t32\n999999\t64\t32\n`);
  assert.equal(summary.shared, 2);
  assert.equal(summary.onlyA, 0);
  assert.equal(summary.fieldMismatch, 0);
});

test('清单乱序也能比：不假设输入已排序', () => {
  const {summary} = run(`${head()}300\t64\t32\n100\t64\t32\n200\t64\t32\n`, `${head()}200\t64\t32\n300\t64\t32\n100\t64\t32\n`);
  assert.equal(summary.shared, 3);
});

test('总量（dlen/clen 求和）来自各自清单，便于核对总体积差', () => {
  const {summary} = run(`${head()}1\t100\t10\n2\t200\t20\n`, `${head()}1\t100\t10\n`);
  assert.deepEqual({dlen: summary.a.dlen, clen: summary.a.clen}, {dlen: 300, clen: 30});
  assert.deepEqual({dlen: summary.b.dlen, clen: summary.b.clen}, {dlen: 100, clen: 10});
});

test('畸形行单独一桶，不静默丢弃（列数/非整数/重复/行中 #）', () => {
  const {out, summary} = run(
    `${head()}1\t64\t32\n坏行\t64\t32\n9\t64\n2\t64\t32\n2\t99\t99\n3\t64\t32 # 注释\n`,
    `${head()}1\t64\t32\n`,
    {expectStatus: 1},
  );
  assert.equal(summary.a.rows, 2, '两个合法 offset（重复的被剔出）');
  assert.equal(summary.malformed.a, 4, '非整数 + 列数不对 + 重复 + 行中注释');
  const bad = readFileSync(join(out, 'malformed-A.txt'), 'utf8');
  assert.match(bad, /存在非整数字段/, '「坏行」三列但非数字');
  assert.match(bad, /列数 2 不是 3/, '缺字段的行要单独报列数');
  assert.match(bad, /offset 2 重复/);
  assert.match(bad, /`#` 出现在行中/);
  assert.ok(summary.warnings.some((w) => w.includes('无法解析')));
});

test('ROM 不一致 -> 拒绝比较、退出码 3、不产出四张表', () => {
  const {out, summary} = run(`${head(ROM_A)}1\t64\t32\n`, `${head(ROM_B)}1\t64\t32\n`, {expectStatus: 3});
  assert.equal(summary.refused.reason, 'rom_sha256 不一致，拒绝比较');
  assert.equal(summary.onlyA, undefined, '拒绝时不应有差集计数');
  assert.ok(!existsSync(join(out, 'only-A.txt')), '拒绝时不应产出表');
});

test('缺 rom_sha256 不拒绝，但要在 warnings 里标出来', () => {
  const {summary} = run(`# 生成器=test\n1\t64\t32\n`, `${head()}1\t64\t32\n`);
  assert.ok(summary.warnings.some((w) => w.includes('rom_sha256')));
});

test('CRLF 行不丢弃数据，但要计数告警', () => {
  const {summary} = run(`${head()}1\t64\t32\r\n2\t64\t32\r\n`, `${head()}1\t64\t32\n2\t64\t32\n`);
  assert.equal(summary.a.rows, 2);
  assert.equal(summary.a.eolWarnings, 2);
  assert.ok(summary.warnings.some((w) => w.includes('CRLF')));
});

test('summary.json 记录比较器自身的 sha256，便于判断"数据变了"还是"工具变了"', () => {
  const {summary} = run(`${head()}1\t64\t32\n`, `${head()}1\t64\t32\n`);
  assert.match(summary.comparator.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(summary.comparator.path, 'games/sacred-stones/scripts/compare-block-lists.mjs');
});

test('头注里的 rom_sha256 与生成器被回声进 summary，便于追来源', () => {
  const {summary} = run(`${head()}1\t64\t32\n`, `${head()}1\t64\t32\n`);
  assert.equal(summary.a.romSha256, ROM_A);
  assert.equal(summary.a.generator, 'test');
});
