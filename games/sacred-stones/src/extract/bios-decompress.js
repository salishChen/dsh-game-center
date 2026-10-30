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
// 压缩比上限（dlen / clen），超过就判假阳性。
//
// LZ77 原来写 8，实测太紧：与逆向的逐流清单做集合差后，有 25 块落在 8.05~8.40
// （都是"整块同色图块"那类高重复数据，dlen 与头部声明完全一致、能精确解出）。
// 上限的意义是挡"随机字节冒充块头"（那种会声明十几 MB），不是挡"压得太好"，
// 所以放到 16 仍然能挡住假阳性，却不再误杀真块。
// **这条数字是量出来的，不是拍的**：改之前先跑 scripts/attribute-only-blocks.mjs。
export const FORMAT_MAX_RATIO = {
  [FORMAT_LZ77]: 16,
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
  // 这里**不再**要求 offset 自身 4 字节对齐。
  //
  // 曾经要求过，理由是"ARM 数据都对齐"。实测推翻：偏移 0xA1317E（%4 == 2）被
  // 0x07B1C8 处一个字 `0x08A1317E` 明确引用，头字节 0x14 → LZ77、dlen=256，
  // 能精确解出 256 字节。GBA BIOS 的 LZ77 解压对**目标偏移**没有对齐要求，
  // 对齐要求只属于"指针字本身在 4 字节边界"（扫描 p += 4 已天然满足）。
  // 把这两件事混成一条闸门，就会漏掉真块——而漏掉时症状是"清单里少一块"，静默。
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
  // blocks：逐个通过闸门的块。导出清单必须用它，否则别人只拿到计数、
  // 没法做集合差——而"只报一个数"正是上一轮数字被当成事实传下去的原因。
  const blocks = [];
  const rejected = {unalignedOrImplausible: 0, undecodable: 0, ratioTooHigh: 0, outOfBounds: 0, dlenExceedsRom: 0};
  let maxRatioObserved = 0;
  const seen = new Set();
  for (const offset of pointers) {
    if (!isPlausibleBlockOffset(bytes, offset)) {
      rejected.unalignedOrImplausible += 1;
      continue;
    }
    const format = formatOf(bytes, offset);
    stats[format].files += 1;
    const result = decompress(bytes, offset, options);
    if (result === null) {
      rejected.undecodable += 1;
      continue;
    }
    if (result.consumed <= 0) {
      rejected.undecodable += 1;
      continue;
    }
    // ── 物理不可能的两条守卫（format 类，可以永久写死）──────────────
    // 与压缩比那类"统计上少见"的闸门不同：这两条挡的是物理上做不到的事，
    // 改口径也不会失效。
    if (offset + result.consumed > bytes.length) {
      rejected.outOfBounds += 1;
      continue;
    }
    if (result.output.length > bytes.length) {
      rejected.dlenExceedsRom += 1;
      continue;
    }
    // ── 压缩比：诊断字段，不是筛选判据 ───────────────────────────────
    // 实测：洗牌基线（种子 20261030）里假阳性的 dlen/clen 最高只到 1.778，
    // 8 这条线永远不会被噪声触及 —— 它剔除的全是真块（历史上有 25 块
    // ratio 8.05~8.40 被误杀）。所以保留数值、不再参与筛选。
    // 若将来要恢复筛选，必须先证明噪声能越过阈值，否则它只是在砍真块。
    const ratio = result.output.length / result.consumed;
    const ratioCap = options.maxRatio?.[format];
    if (ratioCap !== undefined && ratio > ratioCap) {
      rejected.ratioTooHigh += 1;
      continue;
    }
    stats[format].decoded += 1;
    stats[format].compressedBytes += result.consumed;
    stats[format].decompressedBytes += result.output.length;
    if (seen.has(offset)) continue;
    seen.add(offset);
    if (ratio > maxRatioObserved) maxRatioObserved = ratio;
    blocks.push({
      offset,
      format,
      dlen: result.output.length,
      clen: result.consumed,
      ratio,
    });
  }
  return {pointers: pointers.length, stats, blocks, rejected, maxRatioObserved};
}
