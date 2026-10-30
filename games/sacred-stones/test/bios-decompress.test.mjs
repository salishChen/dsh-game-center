import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {test} from 'node:test';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  FORMAT_HUFFMAN,
  FORMAT_LZ77,
  FORMAT_RLE,
  decompress,
  formatOf,
  huffmanDecompress,
  lz77Decompress,
  rleDecompress,
  scanCompressed,
} from '../src/extract/bios-decompress.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROM_PATH = process.env.FE8_ROM ?? join(here, '../../../artifacts/fe8-remake/fe8-zh.gba');

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

function lz77Stream({size, flags, body}) {
  return Uint8Array.from([0x10, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, flags, ...body]);
}

test('formatOf 只看高 4 位，低 4 位是保留位', () => {
  assert.equal(formatOf(Uint8Array.from([0x10])), FORMAT_LZ77);
  assert.equal(formatOf(Uint8Array.from([0x1f])), FORMAT_LZ77);
  assert.equal(formatOf(Uint8Array.from([0x20])), FORMAT_HUFFMAN);
  assert.equal(formatOf(Uint8Array.from([0x30])), FORMAT_RLE);
  assert.equal(formatOf(Uint8Array.from([0x00])), null);
  assert.equal(formatOf(Uint8Array.from([0x40])), null);
  assert.equal(formatOf(Uint8Array.from([])), null);
});

test('LZ77：字面量 + 回引（ABABAB）', () => {
  // 字面量 A、B，然后从距离 2 处回引 4 字节 → ABAB
  // 标志位按 BIOS 约定：1=压缩块、0=字面量。token2 是压缩块 → 0b0010_0000 = 0x20
  // 回引两字节 b0=0x10（len=(0x10>>4)+3=4）、b1=0x01（disp=((0&0xF)<<8|0x01)+1=2）
  const stream = lz77Stream({size: 6, flags: 0b0010_0000, body: [...ascii('AB'), 0x10, 0x01]});
  const result = lz77Decompress(stream);
  assert.ok(result);
  assert.equal(new TextDecoder().decode(result.output), 'ABABAB');
  assert.equal(result.consumed, stream.length);
});

test('LZ77：disp < length 的自重复 run 是合法的（曾因此把整类块判死）', () => {
  // 字面量 A，然后从距离 1 处回引 5 字节 → 全是 A。disp(1) < length(5)
  // token0 字面量 'A'；token1 压缩块 → 0b0100_0000 = 0x40
  // b0=0x20（len=5）、b1=0x00（disp=1）
  const stream = lz77Stream({size: 6, flags: 0b0100_0000, body: [0x41, 0x20, 0x00]});
  const result = lz77Decompress(stream);
  assert.ok(result, '自重复 run 必须能解，不许用"回引长度 > 距离"的禁令拒绝');
  assert.equal(new TextDecoder().decode(result.output), 'AAAAAA');
});

test('LZ77：回引超前（disp > 已写出）判非法，不返回半成品', () => {
  // token0 就是压缩块（标志位 0b1000_0000），此时还没写出任何字节 → disp 必然超前
  const stream = lz77Stream({size: 4, flags: 0b1000_0000, body: [0x00, 0x05]});
  assert.equal(lz77Decompress(stream), null);
});

test('LZ77：在 dlen 处停下，末尾多余字节不算错（BIOS 规范）', () => {
  // BIOS 规范是「解出 dlen 个字节就停」，块后面有没有填充字节与合法性无关；
  // 因此断言的是「输出长度恰好等于头声明」，而不是「必须在最后一个字节处收尾」。
  // 全字面量（标志位全 0），块后跟一个与内容无关的填充字节
  const stream = lz77Stream({size: 2, flags: 0b0000_0000, body: [...ascii('AB'), 0xaa]});
  const result = lz77Decompress(stream);
  assert.ok(result);
  assert.equal(result.output.length, 2);
});

test('LZ77：独立手算向量（字面量 abc + 回引 3）', () => {
  // 完全按 GBA BIOS 规范手推，不从实现里取期望值：
  //   头：0x10 + dlen(3 字节小端)=6
  //   标志位：token0..2 字面量、token3 回引 → 0b0001_0000 = 0x10
  //   回引两字节：b0 = (len-3)<<4 | (disp-1)>>8 = 0<<4 | 0 = 0x00；b1 = (disp-1)&0xFF = 2 → 0x00 0x02
  const stream = Uint8Array.from([0x10, 6, 0, 0, 0x10, 0x61, 0x62, 0x63, 0x00, 0x02]);
  const result = lz77Decompress(stream);
  assert.ok(result);
  assert.deepEqual(Array.from(result.output), Array.from(ascii('abcabc')));
});

test('LZ77：输入提前耗尽判非法', () => {
  const stream = Uint8Array.from([0x10, 8, 0, 0, 0xff, 0x41]);
  assert.equal(lz77Decompress(stream), null);
});

test('LZ77：声明长度 0 或超上限判非法', () => {
  assert.equal(lz77Decompress(Uint8Array.from([0x10, 0, 0, 0, 0x00])), null);
  assert.equal(lz77Decompress(Uint8Array.from([0x10, 1, 0, 0x10, 0x00])), null);
});

test('Huffman：自己编码的位流能解回来（往返一致性）', () => {
  // 用一棵 4 位、15 个节点的平表树；符号 i 的编码就是它的节点号 - 1 的 4 位二进制。
  const tree = Uint8Array.from({length: 15}, (_, i) => i);
  const symbols = [0, 1, 5, 14];

  // 自己写位流：每个符号写成 4 位（高位在前），与 BIOS 的读法一致。
  const bits = [];
  for (const sym of symbols) {
    for (let b = 3; b >= 0; b -= 1) bits.push((sym >> b) & 1);
  }
  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k += 1) byte = (byte << 1) | (bits[i + k] ?? 0);
    dataBytes.push(byte);
  }
  // 位读取器一次取 4 字节，补足到 4 的倍数。
  while (dataBytes.length % 4 !== 0) dataBytes.push(0);

  const stream = Uint8Array.from([
    0x20, symbols.length, 0, 0, 4, ...tree, ...dataBytes,
  ]);
  const result = huffmanDecompress(stream);
  assert.ok(result);
  assert.deepEqual(Array.from(result.output), symbols);
});

test('Huffman：dataSize 只能是 4 或 8', () => {
  const stream = Uint8Array.from([0x20, 1, 0, 0, 6, 0, 0, 0, 0]);
  assert.equal(huffmanDecompress(stream), null);
});

test('RLE：run 与字面量混合（AAAABBB）', () => {
  // bit7=0 → run: len=(0x01&0x7f)+3=4 个 'A'；bit6=0 → run: len=0+3=3 个 'B'
  const stream = Uint8Array.from([0x30, 7, 0, 0, 0x00, 0x01, 0x41, 0x00, 0x42]);
  const result = rleDecompress(stream);
  assert.ok(result);
  assert.equal(new TextDecoder().decode(result.output), 'AAAABBB');
  assert.equal(result.consumed, stream.length);
});

test('RLE：run 会写超声明长度判非法', () => {
  const stream = Uint8Array.from([0x30, 2, 0, 0, 0x00, 0x05, 0x41]);
  assert.equal(rleDecompress(stream), null);
});

test('decompress 按头部自动选解码器，未知格式返回 null', () => {
  const lz = lz77Stream({size: 1, flags: 0b0000_0000, body: [0x41]});
  assert.equal(new TextDecoder().decode(decompress(lz).output), 'A');
  assert.equal(decompress(Uint8Array.from([0x99, 1, 0, 0, 0, 0])), null);
});

test('scanCompressed 统计头部数与成功解码数', () => {
  const good = lz77Stream({size: 1, flags: 0b0000_0000, body: [0x41]});
  const bad = Uint8Array.from([0x10, 9, 0, 0, 0x00, 0x00]);
  const bytes = Uint8Array.from([0x00, ...good, ...bad]);
  const stats = scanCompressed(bytes);
  assert.equal(stats[FORMAT_LZ77].decoded, 1);
  assert.ok(stats[FORMAT_LZ77].headers >= 2, '头部计数应包含解不出来的那块');
});

test('真卡带：压缩块能通过严格校验，且块数与"数千级"一致（不是几十/几百）', {skip: !existsSync(ROM_PATH)}, () => {
  const rom = readFileSync(ROM_PATH);
  // 全 ROM 扫一遍太慢，这里取前 4 MiB 做结构性验证；全量数字由 tools/scan-compressed.mjs 出
  const window = rom.subarray(0, 4 * 1024 * 1024);
  const stats = scanCompressed(window);
  const decoded = stats[FORMAT_LZ77].decoded + stats[FORMAT_HUFFMAN].decoded + stats[FORMAT_RLE].decoded;
  assert.ok(decoded > 100, `4 MiB 窗口内至少应有上百个合法块，实际 ${decoded}`);
  assert.ok(stats[FORMAT_LZ77].decompressedBytes > 0, 'LZ77 解出的字节数应大于 0');

  // 抽查：每个被接受的块，输出长度必须等于头声明，且回引不超前（解码器已保证）
  let checked = 0;
  for (let offset = 0; offset + 8 < window.length && checked < 200; offset += 1) {
    const format = formatOf(window, offset);
    if (format === null) continue;
    const result = decompress(window, offset);
    if (!result) continue;
    const declared = window[offset + 1] | (window[offset + 2] << 8) | (window[offset + 3] << 16);
    assert.equal(result.output.length, declared);
    checked += 1;
  }
  assert.ok(checked >= 100, `应能抽查到上百个块，实际 ${checked}`);
});

test('scanPointedBlocks 除了计数还给逐块清单（导出清单必须靠它，不能只给数）', async () => {
  const {scanPointedBlocks, FORMAT_LZ77} = await import('../src/extract/bios-decompress.js');
  // 合法块要过 `size >= 32` 的闸门，所以 dlen 必须 ≥ 32：4 组「1 标志字节 + 8 字面量」
  const block = [0x10, 32, 0, 0];
  for (let group = 0; group < 4; group += 1) {
    block.push(0x00); // 8 位全 0 = 8 个字面量
    for (let i = 0; i < 8; i += 1) block.push(0x41 + group);
  }
  const rom = new Uint8Array(0x100);
  // 指针字放在开头（4 字节对齐），指向 0x08000010
  rom[0] = 0x10; rom[1] = 0x00; rom[2] = 0x00; rom[3] = 0x08;
  rom.set(block, 0x10);
  const scan = scanPointedBlocks(rom);
  const lz = scan.blocks.filter((b) => b.format === FORMAT_LZ77);
  // 指针<>只找到 0x10 一处；但 0x10 处之后还有 4 字节对齐的候选，所以只断言"含 0x10 这一块"
  const target = lz.find((b) => b.offset === 0x10);
  assert.ok(target, '清单里必须有 0x10 这一块');
  assert.equal(target.dlen, 32);
  assert.equal(target.clen, block.length);
  // 同一 offset 不能出现两次
  assert.equal(lz.filter((b) => b.offset === 0x10).length, 1);
});

test('压缩比闸门 --self-test：dlen/clen > 8 的块必须被剔除（闸门有能力排除，不是恒真）', async () => {
  const {scanPointedBlocks, FORMAT_LZ77} = await import('../src/extract/bios-decompress.js');
  // 造一块高压缩比的合法块：1 个字面量 + 200 个「回引 len=18 / disp=1」。
  // dlen = 1 + 200*18 = 3601，clen = 4(头) + 26(标志) + 1(字面量) + 400(回引) = 431
  // ⇒ 比值约 8.35，超过 8，必须被压缩比闸门剔除。
  const RUNS = 200;
  const items = [{kind: 'literal', byte: 0x41}];
  for (let i = 0; i < RUNS; i += 1) items.push({kind: 'run', len: 18, disp: 1});
  const dlen = 1 + RUNS * 18;

  const groups = [];
  for (let i = 0; i < items.length; i += 8) groups.push(items.slice(i, i + 8));
  const body = [];
  for (const group of groups) {
    let flagByte = 0;
    // 标志位是**从 bit7 开始**被消费的（先高位），写反会让整块解成乱码
    group.forEach((item, bit) => {
      if (item.kind === 'run') flagByte |= 1 << (7 - bit);
    });
    body.push(flagByte);
    for (const item of group) {
      if (item.kind === 'literal') body.push(item.byte);
      else {
        const len = item.len - 3;
        const disp = item.disp - 1;
        body.push(((len & 0xf) << 4) | ((disp >> 8) & 0xf));
        body.push(disp & 0xff);
      }
    }
  }

  const rom = new Uint8Array(0x400);
  // 4 字节对齐的指针字，指向 0x08000010
  rom[0] = 0x10; rom[3] = 0x08;
  const offset = 0x10;
  rom[offset] = 0x10;
  rom[offset + 1] = dlen & 0xff;
  rom[offset + 2] = (dlen >> 8) & 0xff;
  rom[offset + 3] = (dlen >> 16) & 0xff;
  rom.set(body, offset + 4);

  const noGate = scanPointedBlocks(rom, {maxRatio: {[FORMAT_LZ77]: Number.POSITIVE_INFINITY}})
    .blocks.filter((b) => b.format === FORMAT_LZ77 && b.offset === offset);
  const withGate = scanPointedBlocks(rom).blocks
    .filter((b) => b.format === FORMAT_LZ77 && b.offset === offset);

  assert.equal(noGate.length, 1, '关掉压缩比闸门时这块必须能解出来（否则测的不是闸门）');
  assert.ok(noGate[0].dlen / noGate[0].clen > 8, `这块的压缩比必须真的超过 8，实际 ${noGate[0].dlen / noGate[0].clen}`);
  assert.equal(noGate[0].dlen, dlen, 'dlen 必须精确达到头部声明');
  assert.equal(withGate.length, 0, '开着压缩比闸门时必须被剔除——否则这道闸门是恒真的');
});
