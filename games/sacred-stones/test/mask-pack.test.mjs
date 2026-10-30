import {test} from 'node:test';
import assert from 'node:assert/strict';

import {MASK_CONVENTION, packMask, packMaskSha256, maskConventionOf} from '../src/extract/mask-pack.js';

// 期望值来源（必须独立于被测实现）：
//   `vec1` 与 `vec2` 的期望 sha **由 Python 的 hashlib 独立算出**，不是先跑这个实现再抄回来。
//   生成命令：python -c "import hashlib; print(hashlib.sha256(bytes([0xB0,0x40])).hexdigest())"
//   本项目在 LZ77 用例上吃过"先跑实现再抄期望"的亏（自证式假绿），这里刻意不再犯。
const VEC1_EXPECTED_BYTES = 'b040';
const VEC1_EXPECTED_SHA = '5ebc514a714b7e738505fabf839804b26e95d56d0ca54cf6b29052ebd8b9fe37';

const VEC2_EXPECTED_BYTES =
  '000000000000000000000000000000000000000000000000000000000001';
const VEC2_EXPECTED_SHA = '65279e18ab3349670c5e4029a6c82a51ebb51969cb9ea6c486a5248bd50b3d6a';

test('已知答案向量 1：4×2 手构掩码，MSB-first 打包', () => {
  const width = 4;
  const height = 2;
  const pixels = new Uint8Array([
    1, 0, 1, 1, // 第 0 行：0b1011 → 0xB0（bit7..bit4）
    0, 1, 0, 0, // 第 1 行：0b0100 → 0x40
  ]);
  const packed = packMask(pixels, {width, height});
  assert.equal(Buffer.from(packed).toString('hex'), VEC1_EXPECTED_BYTES);
  assert.equal(packMaskSha256(pixels, {width, height}), VEC1_EXPECTED_SHA);
});

test('已知答案向量 2：240×1 只有最右下角一个像素，行末补 0 到 30 字节', () => {
  const width = 240;
  const height = 1;
  const pixels = new Uint8Array(width * height);
  pixels[239] = 1; // 行内第 239 个像素 = 第 29 字节的 bit0
  const packed = packMask(pixels, {width, height});
  assert.equal(packed.length, 30, '每行 ceil(240/8)=30 字节');
  assert.equal(Buffer.from(packed).toString('hex'), VEC2_EXPECTED_BYTES);
  assert.equal(packMaskSha256(pixels, {width, height}), VEC2_EXPECTED_SHA);
});

test('MSB-first 与 LSB-first 会给出不同 sha —— 这就是必须钉死 bit 序的理由', () => {
  const width = 8;
  const pixels = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]); // 只有第 0 个像素
  const msb = packMask(pixels, {width, height: 1})[0];
  assert.equal(msb, 0x80, 'MSB-first：第 0 个像素落在 bit7');
  // LSB-first 会得到 0x01，两者对应的集合完全相同、sha 完全不同。
  assert.notEqual(msb, 0x01);
});

test('约定随产物走：mask_convention 的六项必须齐全', () => {
  const convention = maskConventionOf('bg1-opaque');
  assert.deepEqual(Object.keys(convention).sort(), [
    'bit_source', 'bytes_per_row', 'height', 'msb_first', 'pad', 'row_major', 'width',
  ]);
  assert.equal(convention.width, 240);
  assert.equal(convention.height, 160);
  assert.equal(convention.bytes_per_row, 30);
  assert.equal(convention.msb_first, true);
  assert.equal(convention.row_major, true);
  assert.equal(convention.pad, 'zero-to-byte');
  assert.equal(convention.bit_source, 'bg1-opaque');
});

test('全局约定常量：240×160 / 30 B 每行', () => {
  assert.equal(MASK_CONVENTION.width, 240);
  assert.equal(MASK_CONVENTION.height, 160);
  assert.equal(MASK_CONVENTION.bytes_per_row, 30);
});
