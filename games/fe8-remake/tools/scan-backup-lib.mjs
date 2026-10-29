#!/usr/bin/env node
// 扫描 GBA ROM 的备份库标识串，判定存档介质类型与容量。
// 只读 ROM，不写任何文件（除 --json 指定的输出路径）。
//
// 用法：
//   node games/fe8-remake/tools/scan-backup-lib.mjs <rom.gba> [--json out.json]
//
// 判定表（任天堂 GBA 备份库标准标识）：
//   SRAM_V / SRAM_F_V*   -> SRAM，8 位总线，容量 32 KiB (0x8000)
//   FLASH_V              -> FLASH，64 KiB (0x10000)
//   FLASH512_V           -> FLASH，64 KiB (0x10000)，512 字节扇区
//   FLASH1M_V            -> FLASH，128 KiB (0x20000)
//   EEPROM_V             -> EEPROM，容量看具体型号（4/8/64 Kib），需再判

import {readFileSync} from 'node:fs';
import {writeFileSync} from 'node:fs';

const KNOWN = [
  {pattern: /SRAM_V\d{3}/g, type: 'SRAM', bytes: 0x8000, busWidth: 8, note: '任天堂 SRAM 库'},
  {pattern: /SRAM_F_V\d{3}/g, type: 'SRAM', bytes: 0x8000, busWidth: 8, note: '任天堂 SRAM 库（F 版）'},
  {pattern: /FLASH1M_V\d{3}/g, type: 'FLASH1M', bytes: 0x20000, busWidth: 8, note: '128 KiB FLASH'},
  {pattern: /FLASH512_V\d{3}/g, type: 'FLASH512', bytes: 0x10000, busWidth: 8, note: '64 KiB FLASH，512B 扇区'},
  {pattern: /FLASH_V\d{3}/g, type: 'FLASH', bytes: 0x10000, busWidth: 8, note: '64 KiB FLASH'},
  {pattern: /EEPROM_V\d{3}/g, type: 'EEPROM', bytes: null, busWidth: 1, note: 'EEPROM，容量需按型号再判'},
];

export function scanBackupLib(buffer) {
  const hits = [];
  for (const {pattern, type, bytes, busWidth, note} of KNOWN) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(buffer.toString('latin1'))) !== null) {
      hits.push({offset: m.index, text: m[0], type, bytes, busWidth, note});
      // toString on whole buffer each hit is wasteful; bounded below.
      if (hits.length > 64) break;
    }
  }
  hits.sort((a, b) => a.offset - b.offset);

  // 注意：汉化/改版 ROM 里可能有残片（如 SRAM_F_VA1），正则要求 V + 3 位数字，天然过滤。
  const decided = hits.length > 0 ? hits[0] : null;
  return {
    detected: decided
      ? {type: decided.type, bytes: decided.bytes, busWidth: decided.busWidth, note: decided.note}
      : null,
    hits,
    conclusion: decided
      ? `存档介质：${decided.type}${decided.bytes ? `，${decided.bytes} 字节 (0x${decided.bytes.toString(16)})` : ''}，${decided.busWidth} 位总线`
      : '未找到任何备份库标识串：该 ROM 可能不使用标准备份库，需按写寄存器访问序列实测',
  };
}

function main(argv) {
  const romPath = argv[2];
  if (!romPath) {
    console.error('用法: node scan-backup-lib.mjs <rom.gba> [--json out.json]');
    process.exit(2);
  }
  const buffer = readFileSync(romPath);
  const result = scanBackupLib(buffer);
  const jsonIndex = argv.indexOf('--json');
  const payload = JSON.stringify({rom: romPath, size: buffer.length, ...result}, null, 2);
  if (jsonIndex !== -1 && argv[jsonIndex + 1]) {
    writeFileSync(argv[jsonIndex + 1], payload);
    console.log(`已写入 ${argv[jsonIndex + 1]}`);
  } else {
    console.log(payload);
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('scan-backup-lib.mjs')) {
  main(process.argv);
}
