/**
 * GBA BIOS 解压格式（LZ77 / Huffman / RLE）解码器。
 *
 * 为什么要自己写：复原路线里美术、字库、地图数据全部以这三种格式压在 ROM 里，
 * 提取器解错不会报错——只会解出一屏乱码。所以这里的原则是**宁可拒绝，不可猜**：
 * 任何不自洽（越界、回引超前、解出长度与头声明不符、输入提前耗尽）都返回 null，
 * 绝不返回"部分正确"的结果。
 *
 * 性能：扫描时按「剩余输入 × 合理压缩比」给每个候选设输出上限（`maxOutput`）。
 * 不设的话，一个随机假头部声明 12 MB 输出，就会让解码器在原地跑上百万次循环——
 * 实测全 ROM 扫描会从秒级涨到小时级。
 *
 * 格式（GBATEK, BIOS Decompression Functions）：
 *   0x10 LZ77   : [0x10][size:24][flags byte × n]   flag 高位在前；
 *                 位置 1 = 1 字节字面量；位置 0 = 2 字节回引
 *                 len = (b0 >> 4) + 3, disp = ((b0 & 0x0F) << 8 | b1) + 1
 *   0x20 Huffman: [0x20][size:24][dataSize:1][tree: (1<<dataSize)-1 字节]
 *                 位流高位在前，按 32 位小端字读取；node 从 1 开始，
 *                 左移取 0、右移取 1，node > treeSize 时取 tree[node - treeSize - 1]
 *   0x30 RLE    : [0x30][size:24][flag byte × n]
 *                 位 1 = 1 字节字面量；位 0 = [len][value]，重复 (len & 0x7F) + 3 次
 */

export const FORMAT_LZ77 = 0x10;
export const FORMAT_HUFFMAN = 0x20;
export const FORMAT_RLE = 0x30;

const MAX_OUTPUT = 0x1000000; // 单个块解出 16 MiB 以上的长度一定是错的

function declaredSize(bytes, offset) {
  return bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16);
}

/** 头部字节是否是已知压缩格式（只看高 4 位，低 4 位是保留/版本）。 */
export function formatOf(bytes, offset = 0) {
  const header = bytes[offset];
  if (header === undefined) return null;
  const kind = header & 0xf0;
  if (kind === FORMAT_LZ77) return FORMAT_LZ77;
  if (kind === FORMAT_HUFFMAN) return FORMAT_HUFFMAN;
  if (kind === FORMAT_RLE) return FORMAT_RLE;
  return null;
}

/**
 * LZ77 解压。
 * 关键点：`disp < len` 的自重复 run（BIOS 逐字节从输出区取）是合法且图形压缩的常规手法。
 * 曾有人加了"禁止回引长度 > 距离"这条禁令，把这一整类块判死，导致 509 vs 4933 的十倍误差。
 */
export function lz77Decompress(bytes, offset = 0, {maxOutput = MAX_OUTPUT} = {}) {
  if (formatOf(bytes, offset) !== FORMAT_LZ77) return null;
  const size = declaredSize(bytes, offset);
  if (size === 0 || size > maxOutput) return null;
  if (offset + 4 > bytes.length) return null;

  const out = new Uint8Array(size);
  let written = 0;
  let p = offset + 4;

  while (written < size) {
    if (p >= bytes.length) return null;
    const flags = bytes[p++];
    for (let bit = 7; bit >= 0 && written < size; bit -= 1) {
      // GBA BIOS 的约定：标志位为 1 表示「压缩块（回引）」，为 0 表示「字面量」。
      // 这里原来写反了（1 当字面量），导致真实块一律解成乱码、而随机数据反而"解得通"。
      if (!(flags & (1 << bit))) {
        if (p >= bytes.length) return null;
        out[written++] = bytes[p++];
        continue;
      }
      if (p + 1 >= bytes.length) return null;
      const b0 = bytes[p++];
      const b1 = bytes[p++];
      const length = (b0 >> 4) + 3;
      const disp = (((b0 & 0x0f) << 8) | b1) + 1;
      if (disp > written) return null; // 回引超前：这块不是合法流
      if (written + length > size) return null; // 会写超声明长度
      for (let k = 0; k < length; k += 1) {
        // 逐字节从输出区取：disp < length 时自然形成自重复 run
        out[written] = out[written - disp];
        written += 1;
      }
    }
  }

  return {format: FORMAT_LZ77, output: out, consumed: p - offset};
}

/** 高位在前的位读取器，按 32 位小端字补充（BIOS 的读法）。 */
function createBitReader(bytes, start) {
  let p = start;
  let buffer = 0;
  let available = 0;

  function refill() {
    if (p + 4 > bytes.length) return false;
    // BIOS 的位流是「字节内高位在前、按字节顺序」——必须大端拼装，
    // 用 `b0 | b1<<8 | ...` 小端拼会把位序整个反过来（Huffman 树永远走错分支）。
    buffer = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    p += 4;
    available = 32;
    return true;
  }

  return {
    readBit() {
      if (available === 0 && !refill()) return -1;
      available -= 1;
      const bit = (buffer >>> available) & 1; // available 是「还剩几位」，下一位的下标就是它（31 → 最高位）
      if (available === 0) buffer = 0;
      return bit;
    },
    get position() {
      return p;
    },
  };
}

export function huffmanDecompress(bytes, offset = 0, {maxOutput = MAX_OUTPUT} = {}) {
  if (formatOf(bytes, offset) !== FORMAT_HUFFMAN) return null;
  const size = declaredSize(bytes, offset);
  if (size === 0 || size > maxOutput) return null;

  const dataSize = bytes[offset + 4];
  if (dataSize !== 4 && dataSize !== 8) return null;
  const treeSize = (1 << dataSize) - 1;
  const treeStart = offset + 5;
  if (treeStart + treeSize > bytes.length) return null;
  const tree = bytes.subarray(treeStart, treeStart + treeSize);

  const reader = createBitReader(bytes, treeStart + treeSize);
  const out = new Uint8Array(size);
  let written = 0;

  while (written < size) {
    let node = 1;
    while (node <= treeSize) {
      const bit = reader.readBit();
      if (bit < 0) return null;
      node = (node << 1) | bit;
    }
    const index = node - treeSize - 1;
    if (index >= treeSize) return null;
    out[written++] = tree[index];
  }

  return {format: FORMAT_HUFFMAN, output: out, consumed: reader.position - offset};
}

export function rleDecompress(bytes, offset = 0, {maxOutput = MAX_OUTPUT} = {}) {
  if (formatOf(bytes, offset) !== FORMAT_RLE) return null;
  const size = declaredSize(bytes, offset);
  if (size === 0 || size > maxOutput) return null;

  const out = new Uint8Array(size);
  let written = 0;
  let p = offset + 4;

  while (written < size) {
    if (p >= bytes.length) return null;
    const flags = bytes[p++];
    for (let bit = 7; bit >= 0 && written < size; bit -= 1) {
      if (flags & (1 << bit)) {
        if (p >= bytes.length) return null;
        out[written++] = bytes[p++];
        continue;
      }
      if (p + 1 >= bytes.length) return null;
      const length = (bytes[p] & 0x7f) + 3;
      const value = bytes[p + 1];
      p += 2;
      if (written + length > size) return null;
      out.fill(value, written, written + length);
      written += length;
    }
  }

  return {format: FORMAT_RLE, output: out, consumed: p - offset};
}

/**
 * 按头部自动选择解码器。任何格式不认识或解码不自洽都返回 null。
 */
export function decompress(bytes, offset = 0, options = {}) {
  switch (formatOf(bytes, offset)) {
    case FORMAT_LZ77:
      return lz77Decompress(bytes, offset, options);
    case FORMAT_HUFFMAN:
      return huffmanDecompress(bytes, offset, options);
    case FORMAT_RLE:
      return rleDecompress(bytes, offset, options);
    default:
      return null;
  }
}

/**
 * 扫一遍字节流，统计每种格式"能通过严格校验"的块数。
 * `stopAtFirstSuccess` 用来模拟"跳到已解流之后继续扫"的策略。
 */
export function scanCompressed(bytes, {stopAtFirstSuccess = false, maxRatio = 64, maxBlockOutput = 0x100000} = {}) {
  const stats = {
    [FORMAT_LZ77]: {headers: 0, decoded: 0, compressedBytes: 0, decompressedBytes: 0},
    [FORMAT_HUFFMAN]: {headers: 0, decoded: 0, compressedBytes: 0, decompressedBytes: 0},
    [FORMAT_RLE]: {headers: 0, decoded: 0, compressedBytes: 0, decompressedBytes: 0},
  };

  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    const format = formatOf(bytes, offset);
    if (format === null) continue;
    stats[format].headers += 1;
    // 候选剪枝：假头部常声明几十 MB 输出，直接按上限拒绝会白跑几百万次循环。
    const remaining = bytes.length - offset;
    const maxOutput = Math.min(maxBlockOutput, Math.max(1024, remaining * maxRatio));
    const result = decompress(bytes, offset, {maxOutput});
    if (result === null) continue;
    stats[format].decoded += 1;
    stats[format].compressedBytes += result.consumed;
    stats[format].decompressedBytes += result.output.length;
    if (stopAtFirstSuccess) offset += result.consumed - 1;
  }

  return stats;
}

export const ROM_POINTER_BASE = 0x08000000;

/**
 * 每种格式的合法压缩比上限。超过它的"成功解码"一律当假阳性丢掉。
 *
 * 依据：GBA 的 BIOS 压缩格式压缩率本来就有限——RLE 每 2 字节最多展开 130 字节但真实素材
 * 基本在 1:1~1.5；LZ77 常见 1:2~1:5，理论上限也远小于 1:8；Huffman 约 1:2。
 * 实测反例：不做这个约束时，47,233 个指针里有 51 处"通过校验"的 RLE，
 * 合计解出 254,495,444 B（输入才 16,983,566 B），全部是随机字节凑出来的假块。
 */
export const FORMAT_MAX_RATIO = {
  [FORMAT_LZ77]: 8,
  [FORMAT_HUFFMAN]: 4,
  [FORMAT_RLE]: 2,
};

/**
 * 收集 ROM 里所有指向自身的 32 位指针（`0x08xxxxxx` 字面量），换算成文件偏移。
 *
 * 为什么资产表要用它而不是"每个偏移都试一遍"：
 * 纯扫描会对随机字节产生大量假阳性（一个假头部声明 12 MB 输出、靠随机 flag 位硬填满，
 * 也能通过"长度自洽"这条校验）。真游戏里的压缩块一定被代码用指针引用，
 * 所以**指针枚举才是资产表的判据**，纯扫描只能当召回上界。
 */
export function collectRomPointers(bytes, {base = ROM_POINTER_BASE} = {}) {
  const offsets = new Set();
  for (let p = 0; p + 4 <= bytes.length; p += 4) {
    const word = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
    if (word >= base && word < base + bytes.length) offsets.add(word - base);
  }
  return Array.from(offsets).sort((a, b) => a - b);
}

/**
 * 块头的合理性闸门。光靠"能解出来"远远不够：
 * 47,233 个指针里有 6,557 处高 4 位恰好是 0x10，其中绝大多数是 ARM 指令
 * （`1e ff 2f e1` = bx lr、`12 00 a0 e3` = mov r0,#0x12 这类）撞上了格式魔数。
 * 真素材块还有三个特征：4 字节对齐、解出大小在合理区间、压缩比不离谱。
 */
export const BLOCK_MIN_SIZE = 32;
export const BLOCK_MAX_SIZE = 0x100000;

export function isPlausibleBlockOffset(bytes, offset) {
  if (offset % 4 !== 0) return false;
  const format = formatOf(bytes, offset);
  if (format === null) return false;
  const size = declaredSize(bytes, offset);
  return size >= BLOCK_MIN_SIZE && size <= BLOCK_MAX_SIZE;
}

/** 只在指针指向的偏移上尝试解码，统计每种格式的合法块。 */
export function scanPointedBlocks(bytes, options = {}) {
  const stats = {
    [FORMAT_LZ77]: {files: 0, decoded: 0, compressedBytes: 0, decompressedBytes: 0},
    [FORMAT_HUFFMAN]: {files: 0, decoded: 0, compressedBytes: 0, decompressedBytes: 0},
    [FORMAT_RLE]: {files: 0, decoded: 0, compressedBytes: 0, decompressedBytes: 0},
  };
  const pointers = collectRomPointers(bytes);
  for (const offset of pointers) {
    if (!isPlausibleBlockOffset(bytes, offset)) continue;
    const format = formatOf(bytes, offset);
    stats[format].files += 1;
    const result = decompress(bytes, offset, options);
    if (result === null) continue;
    if (result.consumed <= 0) continue;
    if (result.output.length / result.consumed > FORMAT_MAX_RATIO[format]) continue;
    stats[format].decoded += 1;
    stats[format].compressedBytes += result.consumed;
    stats[format].decompressedBytes += result.output.length;
  }
  return {pointers: pointers.length, stats};
}
