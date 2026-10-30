// 回归：VRAM oracle 认定的"整块命中"必须永远成立。
//
// 夹具 `test/fixtures/vram-title-tiles.json` 是帧 900 标题画面 VRAM 里出现过的
// 1,611 个非纯色图块的哈希（由 `scripts/vram-oracle.mjs --fixture` 生成，只存
// 哈希不存像素）。这个用例不需要模拟器：只解一块卡带数据、比哈希。
//
// 它能抓住的错误：LZ77 标志位写反、Huffman 位序写错、自重复回引处理错——
// 任何一处语义变化都会让这块的图块哈希全部对不上。
//
// 禁令（不要为了"方便"破例）：夹具只能由 VRAM 生成，**绝不可以拿解码器的输出
// 反过来当期望值**。左侧 VRAM 是原代码在模拟器里跑出来的 ground truth，独立于
// 我方实现；一旦夹具改由解码器产出，这条用例就退化成"我同意我自己"，对写反
// 语义的解码器同样通过（`bios-decompress.test.mjs` 早期正是这样假绿的）。
// 生成命令只有一条：
//   node scripts/vram-oracle.mjs --frames 900 --fixture test/fixtures/vram-title-tiles.json
//
// 地址一律由脚本打印后复制：这里这个常量是从
//   `node scripts/vram-oracle.mjs` 输出的十进制 offset 经
//   `('0x' + n.toString(16))` 打印得到，不要手算——我把 11,923,420 心算成
//   0x00B5F69C（正确是 0x00B5EFDC），第一次跑用例直接拿到 `null`，
//   而 `null` 会被当成"这块没数据"，是个静默的假结论。

import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decompress} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const romPath = process.env.SS_ROM ?? join(repoRoot, 'artifacts', 'fe8-remake', 'fe8-zh.gba');
const fixturePath = join(here, 'fixtures', 'vram-title-tiles.json');
const hasRom = existsSync(romPath);

// 帧 900 标题画面里"255 个图块全部在 VRAM 出现"的那一块
const FULL_MATCH_BLOCK = 0x00b5efdc;

const hash32 = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const uniform = (tile) => {
  for (let i = 1; i < tile.length; i += 1) if (tile[i] !== tile[0]) return false;
  return true;
};

test('VRAM 夹具自身自洽：哈希唯一、数量与声明一致', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.tiles.length, fixture.tileCount);
  assert.equal(new Set(fixture.tiles).size, fixture.tileCount, '夹具里不该有重复哈希');
  assert.ok(fixture.frames >= 1);
  assert.match(fixture.note, /未命中不等于不存在/, '范围声明必须在夹具里');
});

test('LZ77 整块命中：0x00B5EFDC 解出的图块全部出现在标题画面 VRAM 里', {skip: !hasRom && '缺卡带（设 SS_ROM 或放到 artifacts/fe8-remake/fe8-zh.gba）'}, () => {
  const rom = new Uint8Array(readFileSync(romPath));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const inVram = new Set(fixture.tiles);

  const result = decompress(rom, FULL_MATCH_BLOCK);
  assert.ok(result, '这块必须解出来；解不出说明解码器语义变了');

  const tiles = [];
  for (let off = 0; off + 32 <= result.output.length; off += 32) {
    const tile = result.output.subarray(off, off + 32);
    if (!uniform(tile)) tiles.push(tile);
  }

  const hashes = tiles.map(hash32);
  assert.equal(tiles.length, 255, `图块数应当是 255（实际 ${tiles.length}）`);
  // 只验成员资格不够：一个"把同一图块回引 255 次"的错误实现也能过
  // （dlen 对、成员资格对、内容全错）。必须同时要求**去重后仍是 255**。
  assert.equal(new Set(hashes).size, 255, `图块内容必须两两不同（去重后 ${new Set(hashes).size} 个）`);

  const missing = hashes.filter((h) => !inVram.has(h));
  assert.equal(
    missing.length,
    0,
    `有 ${missing.length}/255 个图块在标题画面 VRAM 里找不到；第一个缺失哈希 ${missing[0]}`,
  );
});
