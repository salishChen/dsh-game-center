#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# lz77-scan-recall.py —— 全 ROM 纯扫描：BIOS LZ77 有效块**召回上界**
#
# 口径：纯扫描召回上界，不是资产表判据（资产表判据 = 指针引用枚举）。
#       本脚本只回答一个问题：从 ROM 字节流里"看起来合法"的 LZ77 块最多有多少。
#       它不知道哪些块真的被代码引用，所以**绝不能当资产表的分母**。
# 判据：i += 1 逐字节 / 头字节 == 0x10 且低 4 位为 0 / 8 <= size <= 0x400000 / 命中后 i = 流末尾
# 输入：rom_sha256 167ed57921c24f841108f46eabc33cb10e10f141b09d0fa6e75b5c5add3e4df0
# 当前输出：valid_blocks 4933  compressed 7,528,434  decompressed 17,653,532  ratio 0.426（快照，随判据变）
#
# 判据与数字的关系（契约）：**判据不能是一个数字，数字会漂、算法不会。**
#   所以上面那行输出是"某次快照"，任何时候以脚本运行结果为准，不以文档里的数字为准。
#
# 与"指针驱动基线"的结构性差异（不是 bug，两边都可能是对的）：
#   1. 本脚本任意字节偏移（i += 1），不要求 4 字节对齐 ⇒ 会比对齐基线多命中；
#   2. size 下限定为 8，比常见的 size >= 32 更松 ⇒ 会多出 8..31 的小块；
#   3. 无压缩比闸门（常见实现要求 ratio <= 8）⇒ 会多出高压缩比的块；
#   4. 命中后 i = 流末尾、不做块内嵌套扫描 ⇒ 会少掉嵌套在压缩流里的块。
#   1..3 使结果偏高，4 使结果偏低，因此本数只是上界，不是真值。
#
# 独立背书：另一实现在同一口径（逐字节 + 跳过已解流）下复算同为 4,933；
#   不跳过（允许重叠嵌套）为 6,257；随机打乱字节的假阳性基线（seed 20261030）为 553。
#
# 用法：
#   python tools/lz77-scan-recall.py <rom.gba>
#   python tools/lz77-scan-recall.py <rom.gba> --limit 20    # 多打印几行样块
#
# 只读打开 ROM，不写任何文件、不依赖第三方库。
import sys

DEFAULT_ROM = "artifacts/fe8-remake/fe8-zh.gba"


def decode(rom, i):
    """从 rom[i] 尝试解一个 BIOS LZ77 流；成功返回 (解压后长度, 流末尾下标)。"""
    # 类型位在高 4 位（0x10 = LZ77），低 4 位保留必须为 0。
    if rom[i] != 0x10:
        return None
    if i + 4 > len(rom):
        return None
    size = rom[i + 1] | (rom[i + 2] << 8) | (rom[i + 3] << 16)
    if not (8 <= size <= 0x400000):
        return None

    out = 0
    p = i + 4
    n = len(rom)
    while out < size:
        if p >= n:
            return None
        flags = rom[p]
        p += 1
        for bit in range(8):
            if out >= size:
                break
            if flags & (0x80 >> bit):
                # 压缩块：2 字节 → length = 高 4 位 + 3，displacement = 低 12 位 + 1
                if p + 2 > n:
                    return None
                b1, b2 = rom[p], rom[p + 1]
                p += 2
                length = (b1 >> 4) + 3
                disp = ((b1 & 0x0F) << 8) | b2
                if out - disp - 1 < 0:
                    return None
                # 重叠回引合法：BIOS 解压逐字节从输出区取，disp < length 会自重复。
                # 2026-10-30 修正——此前这里有 `out - disp - 1 + length > out: return None`，
                # 把大量 dlen >= 1 KiB 的块全丢了，对外报成 509（真实纯扫描 4,933）。
                out += length
            else:
                if p >= n:
                    return None
                p += 1
                out += 1
    if out != size:
        return None
    return (size, p)


def main(argv):
    rom_path = DEFAULT_ROM
    limit = 10
    args = argv[1:]
    if args and not args[0].startswith("-"):
        rom_path = args[0]
        args = args[1:]
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])

    with open(rom_path, "rb") as fh:
        rom = fh.read()
    n = len(rom)

    blocks = []
    covered = 0
    total = 0
    i = 0
    while i < n - 4:
        if rom[i] == 0x10:
            got = decode(rom, i)
            if got:
                size, end = got
                blocks.append((i, size, end))
                covered += end - i
                total += size
                i = end  # 跳过已解出的流，避免把流内字节当成新头部（→ 4,933）；不跳则 6,257
                continue
        i += 1

    print(f"valid_blocks = {len(blocks)}")
    print(f"compressed_bytes = {covered}  decompressed_bytes = {total}")
    print(f"ratio = {(covered / total if total else 0):.3f}")
    for off, size, end in blocks[:limit]:
        print(f"  off=0x{off:06X} clen={end - off:6d} dlen={size:7d}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
