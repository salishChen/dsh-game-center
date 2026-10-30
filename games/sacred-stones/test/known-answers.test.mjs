// 已知答案测试：对真实卡带上的若干压缩块，钉死 (clen, dlen, 明文 sha256)。
//
// 为什么钉 sha256 而不是钉"能解出来"：
// - 只断言"非空"对标志位语义写反的解码器同样成立（随机字节会被一路当字面量读完，
//   靠 dlen 截断"成功"）。上一轮 LZ77 标志位写反时，通过数从 44 跳到 4463，正是这个盲区。
// - 钉住明文摘要后，任何语义回退（标志位、回引距离、位序）都会在具体块上炸出差异，
//   而且报错能直接指出是哪一块。
//
// 这些摘要由 commit `888b29d` 的解码器产出，并在同一 commit 上复核过两次；
// 若要更新，必须在 PR 里说明为什么旧值错了，不接受"改一下让它过"。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {decompress, FORMAT_LZ77} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROM = join(here, '..', '..', '..', 'artifacts', 'fe8-remake', 'fe8-zh.gba');
const ROM_PATH = process.env.FE8_ROM ? resolve(process.env.FE8_ROM) : DEFAULT_ROM;

// offset → {clen, dlen, sha256(明文)}；offset 均取自 docs/block-list-v1.txt
const KNOWN_ANSWERS = [
  {offset: 917572, clen: 1283, dlen: 8192, sha256:
    '6e6a9a4a2cded0b3bf6920ff9e94e2cce8cfef60c0694955aa62ba5dc5e296fd'},
  {offset: 6709168, clen: 217, dlen: 1200, sha256:
    '3d19871fd00d17642eca170df56a72f280eca20dcd7d9053f82ce784f9a5366b'},
  {offset: 7819688, clen: 629, dlen: 1200, sha256:
    '6905e1b8b0564e5b4ade4fecfcb4bb888be6b4588a5c482fa2c5b2916712ec7c'},
  {offset: 10608904, clen: 650, dlen: 2048, sha256:
    'd2c73b9a4be2d707c4a8334562ab195d2fbf394959ddc79666b46d53780aff3e'},
  {offset: 11951880, clen: 7030, dlen: 8192, sha256:
    '4d14f9693366386924d94394d103e1c0e3f11b788e9fef803b119bec7979fdf2'},
  {offset: 14230736, clen: 89, dlen: 128, sha256:
    '801094937c733b3282f10e4cac4ae85794ec664aceb08218da39898f89eb4afc'},
];

const hasRom = existsSync(ROM_PATH);
const romBytes = hasRom ? readFileSync(ROM_PATH) : null;

test('已知答案向量：真实卡带压缩块的明文摘要', {skip: !hasRom && '缺少真实卡带（设 FE8_ROM 或放到 artifacts/fe8-remake/fe8-zh.gba）'}, () => {
  assert.ok(romBytes, 'ROM 应已读入');
  const actual = [];
  for (const expected of KNOWN_ANSWERS) {
    const result = decompress(romBytes, expected.offset);
    assert.ok(result, `offset ${expected.offset} 应能解出`);
    assert.equal(
      result.output.length,
      expected.dlen,
      `offset ${expected.offset} 的 dlen 不符（标志位或位序语义回退的典型症状）`,
    );
    assert.equal(result.consumed, expected.clen, `offset ${expected.offset} 的 clen 不符`);
    const digest = createHash('sha256').update(result.output).digest('hex');
    actual.push({offset: expected.offset, clen: result.consumed, dlen: result.output.length, sha256: digest});
  }
  // 未钉值时不静默通过：把算出来的值打出来，由人写进表里
  const missing = KNOWN_ANSWERS.filter((k) => k.sha256 === null);
  if (missing.length > 0) {
    assert.fail(
      `以下块尚未钉死摘要，把下面这行写进 KNOWN_ANSWERS 后重跑：\n${JSON.stringify(actual, null, 2)}`,
    );
  }
  for (let i = 0; i < KNOWN_ANSWERS.length; i += 1) {
    assert.equal(actual[i].sha256, KNOWN_ANSWERS[i].sha256, `offset ${KNOWN_ANSWERS[i].offset} 的明文摘要不符`);
  }
});

test('已知答案向量：块头格式位为 LZ77', {skip: !hasRom && '缺少真实卡带'}, () => {
  for (const {offset} of KNOWN_ANSWERS) {
    assert.equal(romBytes[offset] >> 4, FORMAT_LZ77 >> 4, `offset ${offset} 的格式位应为 0x1`);
  }
});
