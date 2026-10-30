#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# lz77-gate-attr.py —— 把"纯扫描"的块按闸门归因，并在与"指针驱动基线"比较前先切总体
#
# 为什么要有这个脚本（PM 2026-10-30 要求）：
#   4,933（纯扫描召回上界）与 4,425（指针驱动资产表）差的 508 块里，**主要成分不是闸门取值，
#   而是两者在枚举不同的东西**：纯扫描不要求块被任何指针字引用。所以直接做集合差，会得出
#   "闸门差异有 500 块"这种结论，而它多半是假的。
#   正确顺序：先按"是否被合法指针字引用"切总体 → 再在**同总体**内按闸门打标签 → 只有标签为
#   `[]`（三条闸门全过）的残差才值得逐块追。
#
# 判据（全部写死，改判据就必须改这一行注释并重跑）：
#   A. 枚举：任意字节偏移 i += 1；头字节必须正好 0x10（低 4 位为 0）；8 <= dlen <= 0x400000；
#      命中后 i = 流末尾（不做块内嵌套）。
#   B. 指针字：ROM 内任意位置的 32 位小端字 W，若 0x08000000 <= W < 0x08000000 + len(ROM)，
#      则视为"引用了解压偏移 W - 0x08000000"。这是**上界判据**：指针可以运行时算出、也可以
#      指向指针表，本脚本看不到；反过来随机字节也可能凑出这种字（本 ROM 上期望误命中约 19 个，
#      量级 0.4%），所以「有引用」不足以定案，「连随机命中都没有」才接近硬结论。
#   C. 闸门标签（对齐基线的三道，取自 PM 转述的游戏实现口径）：
#      align：offset % 4 != 0
#      size ：dlen < 32
#      ratio：压缩比超限 —— **语义有歧义，两种都算并分别报数**（见下）
#
# 压缩比歧义（必须由口径所有者确认，本脚本不替它决定）：
#   ratio_a：dlen / clen > 8   （压缩倍数过大 → 疑似假阳性）
#   ratio_b：clen / dlen > 8   （压缩后反而更大 → 疑似假阳性）
#   默认按 ratio_a 打标签（"压缩比 <= 8"通常指压缩倍数），同时把 ratio_b 的命中数一起打印。
#
# 用法：
#   python tools/lz77-gate-attr.py <rom.gba> --emit-tsv <my-4933.tsv> [--other <other-4425.tsv>]
#                                        [--out <dir>] [--ratio b]
# 输出：
#   <out>/my-blocks.tsv            我这边的块清单（offset/dlen/clen，按 offset 升序）
#   <out>/bucket-<标签>.tsv        八个桶各自的偏移清单（仅在 --other 不给时也照出）
#   <out>/summary.json             计数、判据取值、输入 sha256、残差清单
#   <out>/residual.tsv             标签为 [] 且不在对方 tsv 里的块（--other 给定时才出）
#
# 只读 ROM 与输入 tsv；只写 --out 目录。
import hashlib
import json
import os
import sys

DEFAULT_ROM = "artifacts/fe8-remake/fe8-zh.gba"
ROM_BASE = 0x08000000
GATE_LABELS = ("align", "size", "ratio")


# ---------------------------------------------------------------- 枚举（判据 A）

def decode(rom, i):
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
                if p + 2 > n:
                    return None
                b1, b2 = rom[p], rom[p + 1]
                p += 2
                length = (b1 >> 4) + 3
                disp = ((b1 & 0x0F) << 8) | b2
                if out - disp - 1 < 0:
                    return None
                # 重叠回引合法（BIOS 逐字节从输出区取）；曾因禁用它把 4,933 误算成 509。
                out += length
            else:
                if p >= n:
                    return None
                p += 1
                out += 1
    if out != size:
        return None
    return (size, p)


def scan(rom):
    n = len(rom)
    blocks = []
    i = 0
    while i < n - 4:
        if rom[i] == 0x10:
            got = decode(rom, i)
            if got:
                size, end = got
                blocks.append((i, size, end - i))
                i = end  # 跳过已解流（→ 4,933）；不跳则 6,257
                continue
        i += 1
    return blocks


# ------------------------------------------------------------ 指针字（判据 B）

def referenced_offsets(rom, align=1):
    """返回 (被引用的解压偏移集合, 命中的指针字个数)。

    align：扫描指针字时的步长。1 = 任意位置（最松），4 = 只认 4 字节对齐位置（最紧）。
    这个步长是**判据的一部分**，不是细节：本 ROM 上 align=1 得 98,617 个被引用偏移、
    align=4 得 47,233 个，对应"有指针的块"从 4,700 掉到 4,451 —— 它比三道闸门加起来
    影响更大。不加对齐限制等于假设"指针字可以出现在任何字节位置"，那是未经验证的假设；
    加对齐限制同样是假设。所以两种都要能跑出来，由口径所有者认领哪一种。
    """
    n = len(rom)
    hit = set()
    count = 0
    limit = ROM_BASE + n
    for i in range(0, n - 3, align):
        w = rom[i] | (rom[i + 1] << 8) | (rom[i + 2] << 16) | (rom[i + 3] << 24)
        if ROM_BASE <= w < limit:
            hit.add(w - ROM_BASE)
            count += 1
    return hit, count


# ------------------------------------------------------------------- 主流程

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_tsv_offsets(path):
    offsets = set()
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            first = line.split("\t")[0].split()[0]
            if first.lower().startswith("0x"):
                offsets.add(int(first, 16))
            else:
                offsets.add(int(first, 10))
    return offsets


def bucket_name(labels):
    return "+".join(labels) if labels else "pass-all"


def emulate_pointer_driven(rom, blocks, ratio_mode):
    """按「指针驱动 + 三道闸门」模拟一遍资产表口径，两种指针对齐各自出数。

    存在的理由：4,933 与对方 4,425 的差曾被猜成"闸门差异"，实测主要来自**指针字的对齐要求**。
    这段代码把那句话变成可重跑的：alignment=1 与 alignment=4 各跑一遍，谁都别再口算。
    """
    result = {}
    for align in (1, 4):
        ref, ptr_words = referenced_offsets(rom, align)
        with_ptr = [b for b in blocks if b[0] in ref]
        gated = [
            b
            for b in with_ptr
            if b[0] % 4 == 0 and b[1] >= 32 and b[2] > 0 and b[1] / b[2] <= 8
        ]
        result[f"ptr_align_{align}"] = {
            "pointer_words": ptr_words,
            "blocks_with_pointer": len(with_ptr),
            "gated_blocks": len(gated),
            "gated_clen": sum(b[2] for b in gated),
            "gated_dlen": sum(b[1] for b in gated),
        }
    return result


def main(argv):
    args = argv[1:]
    rom_path = DEFAULT_ROM
    if args and not args[0].startswith("-"):
        rom_path = args[0]
        args = args[1:]

    def opt(name, default=None):
        if name in args:
            return args[args.index(name) + 1]
        return default

    out_dir = opt("--out", ".botharness/handoff/gate-attr")
    emit_tsv = opt("--emit-tsv")
    other = opt("--other")
    ratio_mode = opt("--ratio", "a")
    ptr_align = int(opt("--ptr-align", "1"))

    with open(rom_path, "rb") as fh:
        rom = fh.read()

    blocks = scan(rom)
    ref, ptr_count = referenced_offsets(rom, ptr_align)

    os.makedirs(out_dir, exist_ok=True)

    # 我这边的清单
    my_tsv = emit_tsv or os.path.join(out_dir, "my-blocks.tsv")
    os.makedirs(os.path.dirname(os.path.abspath(my_tsv)) or ".", exist_ok=True)
    with open(my_tsv, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# 纯扫描召回上界，不是资产表判据\n")
        fh.write(f"# rom_sha256 {sha256_file(rom_path)}\n")
        fh.write(f"# 生成器 {os.path.basename(__file__)}\n")
        fh.write("# 判据 i+=1 / head==0x10 / 8<=dlen<=0x400000 / 命中后 i=流末尾\n")
        fh.write(f"# 数据行 {len(blocks)}\n")
        fh.write("offset\tdlen\tclen\n")
        for off, dlen, clen in sorted(blocks):
            fh.write(f"0x{off:06X}\t{dlen}\t{clen}\n")

    # 闸门标签
    def labels(off, dlen, clen):
        got = []
        if off % 4 != 0:
            got.append("align")
        if dlen < 32:
            got.append("size")
        if ratio_mode == "b":
            if clen > 0 and clen / dlen > 8:
                got.append("ratio")
        else:
            if clen > 0 and dlen / clen > 8:
                got.append("ratio")
        return got

    ratio_b_hits = sum(1 for off, dlen, clen in blocks if clen > 0 and clen / dlen > 8)
    ratio_a_hits = sum(1 for off, dlen, clen in blocks if clen > 0 and dlen / clen > 8)

    buckets = {}
    buckets_ref = {}
    with_ref = []
    for off, dlen, clen in blocks:
        name = bucket_name(labels(off, dlen, clen))
        buckets.setdefault(name, []).append(off)
        if off in ref:
            with_ref.append((off, dlen, clen))
            buckets_ref.setdefault(name, []).append(off)

    for name, offs in buckets.items():
        with open(os.path.join(out_dir, f"bucket-{name}.tsv"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(f"# bucket {name}  count {len(offs)}\n")
            fh.write("offset\n")
            for off in sorted(offs):
                fh.write(f"0x{off:06X}\n")

    summary = {
        "rom": rom_path,
        "rom_sha256": sha256_file(rom_path),
        "criteria": {
            "enumeration": "pure-scan: i+=1, head==0x10, 8<=dlen<=0x400000, skip-resolved-stream",
            "pointer_word": f"LE32 step={ptr_align} in [0x08000000, 0x08000000+len(rom))",
            "gates": ["offset%4!=0", "dlen<32", f"ratio_mode={ratio_mode} (dlen/clen>8)"],
            "ratio_ambiguity": {
                "ratio_a_dlen_over_clen_gt_8": ratio_a_hits,
                "ratio_b_clen_over_dlen_gt_8": ratio_b_hits,
                "note": "口径所有者必须确认用哪一种；本脚本默认 a",
            },
        },
        "counts": {
            "blocks": len(blocks),
            "pointer_words_hit": ptr_count,
            "blocks_with_pointer": len(with_ref),
            "blocks_without_pointer": len(blocks) - len(with_ref),
            "buckets": {name: len(offs) for name, offs in sorted(buckets.items())},
            # 只看"至少被一个指针字引用"的子集：这才和指针驱动基线是同总体
            "buckets_referenced": {name: len(offs) for name, offs in sorted(buckets_ref.items())},
            "buckets_without_pointer": {
                name: len(buckets[name]) - len(buckets_ref.get(name, []))
                for name in sorted(buckets)
            },
        },
        "tsv": {"mine": my_tsv, "mine_sha256": sha256_file(my_tsv)},
        # 「指针驱动 + 三道闸门」的模拟结果：和对方 4,425 的口径对照就靠这一段
        "emulated_pointer_driven_baseline": emulate_pointer_driven(rom, blocks, ratio_mode),
    }

    if other:
        other_offs = read_tsv_offsets(other)
        summary["other"] = {"path": other, "sha256": sha256_file(other), "rows": len(other_offs)}
        # 残差：三条闸门全过、且不在对方清单里的块。**只有这些值得逐块追。**
        residual = [off for off in buckets.get("pass-all", []) if off not in other_offs]
        with open(os.path.join(out_dir, "residual.tsv"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("# 三条闸门全过、却不在对方 tsv 里 —— 唯一值得逐块归因的集合\n")
            fh.write("offset\n")
            for off in sorted(residual):
                fh.write(f"0x{off:06X}\n")
        summary["residual"] = {
            "count": len(residual),
            "only_in_mine_all": len([o for o, _, _ in blocks if o not in other_offs]),
            "only_in_other": len([o for o in other_offs if o not in {b[0] for b in blocks}]),
            "file": os.path.join(out_dir, "residual.tsv"),
        }

    with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(json.dumps(summary["counts"], ensure_ascii=False, indent=2))
    if other:
        print(json.dumps(summary["residual"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
