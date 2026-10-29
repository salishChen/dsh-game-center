import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAddressTable, assertRomMatches} from '../src/core/address-table.js';

const ROM = 'sha256:167ed57921c24f841108f46eabc33cb10e10f141b09d0fa6e75b5c5add3e4df0';

function table(entries = {cursorX: {address: '0x0202BCC4', type: 'u16'}}, romId = ROM) {
  return {schema: 1, romId, entries};
}

test('地址表：正常解析，宽度按 type 推导', () => {
  const parsed = parseAddressTable(table({
    cursorX: {address: '0x0202BCC4', type: 'u16'},
    flag: {address: '0x00000001', type: 'u8'},
    pointer: {address: '0x03000000', type: 'u32'},
  }));
  assert.equal(parsed.entries.get('cursorX').address, 0x0202bcc4);
  assert.equal(parsed.entries.get('cursorX').width, 2);
  assert.equal(parsed.entries.get('flag').width, 1);
  assert.equal(parsed.entries.get('pointer').width, 4);
});

test('地址表：缺 romId 直接拒绝（不知道地址是在哪份 ROM 上测的，就不能用）', () => {
  assert.throws(() => parseAddressTable({schema: 1, entries: {a: {address: 0x10}}}), /romId/);
});

test('地址表：schema 不符拒绝', () => {
  assert.throws(() => parseAddressTable({schema: 2, romId: ROM, entries: {a: {address: 0x10}}}), /schema/);
});

test('地址表：地址越界或非整数拒绝', () => {
  assert.throws(() => parseAddressTable(table({a: {address: -1}})), /不合法/);
  assert.throws(() => parseAddressTable(table({a: {address: 0x1_0000_0000}})), /不合法/);
  assert.throws(() => parseAddressTable(table({a: {address: 'zzz'}})), /不合法/);
});

test('地址表：u16 地址必须 2 字节对齐', () => {
  assert.throws(() => parseAddressTable(table({a: {address: 0x0202bcc5, type: 'u16'}})), /对齐/);
  // u8 不要求对齐
  assert.doesNotThrow(() => parseAddressTable(table({a: {address: 0x0202bcc5, type: 'u8'}})));
});

test('地址表：entries 为空拒绝', () => {
  assert.throws(() => parseAddressTable(table({})), /为空/);
});

test('版本闸门：ROM 对不上必须拒绝，且消息里带两个 romId', () => {
  const parsed = parseAddressTable(table());
  assert.throws(() => assertRomMatches(parsed, 'sha256:deadbeef'), /不匹配/);
  assert.throws(() => assertRomMatches(parsed, 'sha256:deadbeef'), /sha256:deadbeef/);
});

test('版本闸门：不提供当前 romId 也拒绝（不能默默跳过校验）', () => {
  const parsed = parseAddressTable(table());
  assert.throws(() => assertRomMatches(parsed, null), /必须提供/);
});

test('版本闸门：显式 allowMismatch 才放行（逆向实验用）', () => {
  const parsed = parseAddressTable(table());
  assert.doesNotThrow(() => assertRomMatches(parsed, 'sha256:other', {allowMismatch: true}));
});
