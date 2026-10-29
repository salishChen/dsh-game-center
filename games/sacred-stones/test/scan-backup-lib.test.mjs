import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scanBackupLib} from '../tools/scan-backup-lib.mjs';

function romWith(strings, size = 0x1000) {
  const buf = Buffer.alloc(size);
  let offset = 0x40;
  for (const s of strings) {
    buf.write(s, offset, 'latin1');
    offset += 0x40;
  }
  return buf;
}

test('scan: SRAM_F_V103 -> SRAM 32 KiB', () => {
  const r = scanBackupLib(romWith(['SRAM_F_V103']));
  assert.equal(r.detected.type, 'SRAM');
  assert.equal(r.detected.bytes, 0x8000);
  assert.equal(r.detected.busWidth, 8);
  assert.equal(r.hits.length, 1);
  assert.match(r.hits[0].text, /^SRAM_F_V103$/);
});

test('scan: FLASH1M_V103 -> FLASH1M 128 KiB，且不会被 FLASH_V 规则重复计入', () => {
  const r = scanBackupLib(romWith(['FLASH1M_V103']));
  assert.equal(r.detected.type, 'FLASH1M');
  assert.equal(r.detected.bytes, 0x20000);
  assert.equal(r.hits.length, 1, '一个标识串只应记一次');
});

test('scan: 残片 SRAM_F_VA1 不算数（必须 V + 3 位数字）', () => {
  const r = scanBackupLib(romWith(['SRAM_F_VA1', 'SRAM_F_V1']));
  assert.equal(r.detected, null);
  assert.equal(r.hits.length, 0);
});

test('scan: 无标识 -> detected null 且给出可执行的下一步', () => {
  const r = scanBackupLib(romWith(['NO_SAVE_HERE']));
  assert.equal(r.detected, null);
  assert.match(r.conclusion, /实测/);
});

test('scan: 多个命中按偏移升序，结论取最早一个', () => {
  const r = scanBackupLib(romWith(['FLASH_V123', 'SRAM_F_V103']));
  assert.equal(r.hits.length, 2);
  assert.ok(r.hits[0].offset < r.hits[1].offset);
  assert.equal(r.detected.type, 'FLASH');
});
