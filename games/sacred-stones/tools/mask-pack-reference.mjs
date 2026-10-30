#!/usr/bin/env node
/**
 * 1-bit 掩码打包器（掩码对撞用的"表示层"实现）。
 *
 * 为什么单独存在：掩码对撞的判据是"打包 sha 相等"，但 sha 只有在**约定**被钉死时才有意义。
 * 之前两侧各写各的打包器，同一个像素集合给出四个不同 sha —— 那只说明约定有分歧，
 * 不说明内容不同。所以这里给出一份**已知答案向量**，任何实现（含本文件）都必须复现它。
 *
 * 约定（v1）：
 *   - row_major: 从第 0 行开始，每行内从左到右
 *   - msb_first: 每字节内先出现的像素占 bit7，其次 bit6 ……
 *   - 行末补 0 到整字节边界（`pad: 'zero-to-byte-per-row'`），**不跨行续位**
 *     240 px / 8 = 30 B/行；行宽不是 8 的倍数时同样独立补位
 *   - 位值 1 = 该像素属于本掩码集合；0 = 不属于
 *
 * 用法：
 *   node tools/mask-pack/pack.mjs --selftest
 *   node tools/mask-pack/pack.mjs --mask <file> [--json]   # 每行一个像素、'1'/'0'（也接受 '#', '.', 空格）
 */

import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const CONVENTION = {
  version: 1,
  rowMajor: true,
  msbFirst: true,
  pad: 'zero-to-byte-per-row',
  bitSource: {
    'bg1-opaque': 'BG1 层在该像素存在不透明像素（调色板索引 ≠ 0），与"白"/alpha 无关',
    'same-result': '两种配置下硬件输出相同的像素（不可判区），由参照侧算出',
  },
};

/** 把一行像素（0/1 数组）打包成字节；末尾不足 8 位补 0。 */
export function packRow(row) {
  const out = [];
  for (let i = 0; i < row.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      const v = i + b < row.length ? row[i + b] : 0;
      if (v) byte |= 0x80 >> b;
    }
    out.push(byte);
  }
  return out;
}

/** 把整幅掩码（二维 0/1）打包成 Buffer，行优先、每行独立补位。 */
export function packMask(rows) {
  const widths = new Set(rows.map((r) => r.length));
  if (widths.size > 1) throw new Error(`行宽不一致: ${[...widths].join(',')}`);
  const out = [];
  for (const row of rows) out.push(...packRow(row));
  return Buffer.from(out);
}

export function sha256(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/**
 * 已知答案向量。
 *
 * `expectedBytes` 是**手写**的（按上面约定逐位推出来），不是任何打包器的输出；
 * `expectedSha256` 只是对这些手写字节取哈希 —— 取哈希不是打包。
 * 所以"某打包器复现了这些字节"是证据，而不是"同一个实现算了两遍得到同一个值"。
 */
export const VECTORS = [
  {
    name: 'V1 4×2 手写位模式（宽度非 8 的倍数，验行末补位）',
    width: 4,
    height: 2,
    rows: [
      [1, 0, 0, 1],
      [0, 1, 1, 0],
    ],
    // row0: bit7..bit4 = 1001 → 0x90；row1: bit7..bit4 = 0110 → 0x60
    expectedBytes: [0x90, 0x60],
  },
  {
    name: 'V2 240×1 首尾两列置位（验 30 B/行 与末列落在 bit0）',
    width: 240,
    height: 1,
    rows: [Array.from({length: 240}, (_, i) => (i === 0 || i === 239 ? 1 : 0))],
    // col0 → 第 0 字节 bit7 = 0x80；col239 → 第 29 字节 bit0 = 0x01
    expectedBytes: [0x80, ...Array(28).fill(0x00), 0x01],
  },
];

function selftest() {
  let n = 0;
  const fails = [];
  const check = (name, cond, detail) => {
    n++;
    if (cond) console.log(`  ok   ${name}`);
    else {
      fails.push(name);
      console.log(`  FAIL ${name}  ${detail}`);
    }
  };

  for (const v of VECTORS) {
    const got = packMask(v.rows);
    const want = Buffer.from(v.expectedBytes);
    check(
      `${v.name} → 字节逐位一致（${want.length} B）`,
      got.equals(want),
      `got=${got.toString('hex')} want=${want.toString('hex')}`,
    );
    check(`${v.name} → sha 与手写字节一致`, sha256(got) === sha256(want), `got=${sha256(got)} want=${sha256(want)}`);
  }

  // 行末补位必须独立：短行不能跨行续位
  // 9 px/行 ⇒ 每行 2 B：row0 = 0xFF,0x80（最后一位置 1、其余补 0）；row1 全 0 ⇒ 0x00,0x00
  const twoShort = packMask([
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ]);
  check('第 2 行不承接第 1 行余位（行末补 0）', twoShort.equals(Buffer.from([0xff, 0x80, 0x00, 0x00])), twoShort.toString('hex'));

  // 宽度不一致必须报错，不能悄悄按第一行补齐
  let threw = false;
  try {
    packMask([[1, 0], [1, 0, 0]]);
  } catch {
    threw = true;
  }
  check('行宽不一致抛错', threw, '未抛错');

  const full = Array.from({length: 160}, () => Array(240).fill(0));
  check('240×160 → 4,800 B', packMask(full).length === 4800, String(packMask(full).length));

  // 向量必须能**区分** bit 序，否则它钉不住约定。
  // LSB-first（`1 << b`）与我们的 MSB-first（`0x80 >> b`）在 V1 上给出的字节不同：
  //   MSB-first: [1,0,0,1] → 0b10010000 = 0x90 ；LSB-first: bit0|bit3 → 0x09
  const lsbRow = (row) => {
    const out = [];
    for (let i = 0; i < row.length; i += 8) {
      let byte = 0;
      for (let b = 0; b < 8; b++) if (i + b < row.length && row[i + b]) byte |= 1 << b;
      out.push(byte);
    }
    return out;
  };
  const lsbBytes = Buffer.from([...lsbRow(VECTORS[0].rows[0]), ...lsbRow(VECTORS[0].rows[1])]);
  check(
    '向量能区分 MSB-first 与 LSB-first（LSB 版应得 09 06，不等于 90 60）',
    lsbBytes.equals(Buffer.from([0x09, 0x06])) && !lsbBytes.equals(Buffer.from(VECTORS[0].expectedBytes)),
    lsbBytes.toString('hex'),
  );

  if (fails.length) {
    console.log(`\nself-test FAIL (${fails.length}/${n}): ${fails.join('; ')}`);
    process.exit(1);
  }
  console.log(`\nself-test PASS (${n} 条)`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();
  const at = argv.indexOf('--mask');
  if (at < 0 || !argv[at + 1]) {
    console.error('用法: pack.mjs --selftest | --mask <file> [--json]');
    process.exit(2);
  }
  const text = readFileSync(argv[at + 1], 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const rows = text.split('\n').map((line) => {
    const s = line.trim();
    return [...s].map((c) => {
      if (c === '1' || c === '#' || c === 'W' || c === 'w') return 1;
      if (c === '0' || c === '.' || c === ' ') return 0;
      throw new Error(`掩码里有非法字符 ${JSON.stringify(c)}`);
    });
  });
  const bytes = packMask(rows);
  const summary = {
    width: rows[0]?.length ?? 0,
    height: rows.length,
    bytes: bytes.length,
    maskConvention: CONVENTION,
    conventionVector: VECTORS.map((v) => ({
      name: v.name,
      width: v.width,
      height: v.height,
      bytes: v.expectedBytes.length,
      sha256: sha256(Buffer.from(v.expectedBytes)),
    })),
    sha256: sha256(bytes),
  };
  if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else console.log(`mask ${summary.width}×${summary.height}  ${summary.bytes} B  ${summary.sha256}`);
  return 0;
}

// 只有被直接执行时才跑 main()，被 import 时只导出约定与向量（否则别人 import 会顺手跑一遍 CLI）
const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/tools/mask-pack/pack.mjs');
if (invokedDirectly) main();
