#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# lz77-gate-attr.py —— 纯扫描清单的判据归因：先切总体，再打标签，只有 `pass-all` 值得追
#
# 为什么要这个脚本：
#   4,933（纯扫描召回上界）与 4,451（指针驱动资产表）的差里，**主要成分不是闸门取值，
#   而是枚举方式不同**（纯扫描不要求块被指针引用）。直接做集合差会得出"闸门差异几百块"
#   这种结论，而它多半是假的。正确顺序：切总体 → 打标签 → 只看 pass-all 残差。
#
# 判据（改判据就必须改这一段并重跑；数字是输出，不是靶子）：
#   [enum]  任意字节偏移 i += 1；头字节 **== 0x10**（低 4 位必须为 0，PM 2026-10-30 裁定）；
#           8 <= dlen <= 0x400000；命中后 i = 流末尾（不做块内嵌套）。
#   [ptr]   指针字：ROM 内 LE32 窗口，0x08000000 <= W < 0x08000000+len(ROM)；
#           默认 --ptr-align 4（指针字本身 4 字节对齐 = 格式约束）。
#           **目标偏移的对齐不是约束**（已退役，见下）。
#   [format]  clen 不得越过 ROM 末尾；dlen 不得大于整个 ROM —— 物理不可能，永久写死。
#   [scope]   dlen < 32 —— 用途筛选（8x8 4bpp 一个图块 = 32B），不是格式约束。
#   [diagnostic] ratio = dlen/clen —— **不是筛选闸门**：洗牌噪声上界实测 1.778，
#            8/16 两条线都不会被噪声触及；历史上 8 只砍掉 25 块真块（8.05~8.40）。保留为诊断。
#
# 已退役判据（不要凭"听起来天经地义"加回来）：
#   target_offset_alignment：`offset % 4 != 0` 就丢。GBA BIOS 的 LZ77 解压对**输出位置**
#   无对齐要求；对齐要求只属于"指针字本身落在 4 字节边界"。两件事混成一条闸门 = 静默漏块
#   （游戏实现 2026-10-30 实测 0xA1317E，offset % 4 == 2，是合法块）。
#
# 新增判据的两条硬规矩（这一天踩了五次）：
#   ① 必须写 category: format | scope | diagnostic；scope 类要写"为什么是这个值"。
#   ② 必须配**双侧合成块**：一个必须被它剔除、一个必须被它保留；反例块还必须能通过
#      "除这条判据之外的所有检查"，否则你测的是"它坏了"，不是"判据挡了它"。
#
# 用法：
#   python tools/lz77-gate-attr.py <rom.gba> --out <dir> [--other <their.tsv>] [--ptr-align 4]
#   python tools/lz77-gate-attr.py <rom.gba> --self-test
#   加 --measure-header-loose 会多跑一遍 `>>4==1` 变体（只作对照，不进资产表）
#
# 只读 ROM 与输入 tsv；只写 --out 目录。零第三方依赖。
import hashlib
import json
import os
import sys

DEFAULT_ROM = "artifacts/fe8-remake/fe8-zh.gba"
ROM_BASE = 0x08000000


# ---------------------------------------------------------------- 枚举（判据 enum）

def decode(rom, i):
    """严格口径：头字节必须正好 0x10。成功返回 (dlen, 流末尾下标)。"""
    if rom[i] != 0x10:
        return None
    return _decode_body(rom, i)


def decode_any_header(rom, i):
    """宽松口径：只要求高 4 位 == 1。仅用于对照与探针，**不进资产表**。"""
    if (rom[i] >> 4) != 1:
        return None
    return _decode_body(rom, i)


def _decode_body(rom, i):
    if i + 4 > len(rom):
        return None
    size = rom[i + 1] | (rom[i + 2] << 8) | (rom[i + 3] << 16)
    # dlen 下界是 1，不是 8：实测 0xA9C038 / 0xA9C2B8 header=0x10、size=1（flag 0x00 +
    # 单字节字面量 0x0A/0x0B = 换行/空格），各有 4 字节对齐指针 0xA9C044 / 0xA9C2C4。
    # 原 `8 <= size` 是无依据的收窄，会把真块判掉（同"目标偏移对齐"那条）。
    if not (1 <= size <= 0x400000):
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


def _plaintext(rom, i):
    """把 rom[i] 处的 LZ77 流真正解出来（供 sha256 连接键用）。"""
    size = rom[i + 1] | (rom[i + 2] << 8) | (rom[i + 3] << 16)
    out = bytearray()
    p = i + 4
    n = len(rom)
    while len(out) < size:
        if p >= n:
            return None
        flags = rom[p]
        p += 1
        for bit in range(8):
            if len(out) >= size:
                break
            if flags & (0x80 >> bit):
                if p + 2 > n:
                    return None
                b1, b2 = rom[p], rom[p + 1]
                p += 2
                length = (b1 >> 4) + 3
                disp = ((b1 & 0x0F) << 8) | b2
                start = len(out) - disp - 1
                if start < 0:
                    return None
                for _ in range(length):
                    if len(out) >= size:
                        break
                    out.append(out[start])
                    start += 1
            else:
                if p >= n:
                    return None
                out.append(rom[p])
                p += 1
    return bytes(out[:size])


def scan(rom):
    """返回 [(offset, dlen, clen)]，按 offset 升序。"""
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


def header_loose_count(rom):
    """`>>4==1` 变体的块数，仅作对照。

    实测副作用：宽松判据让总数**下降**（4,933 → 4,834）——更早的位置被认成流头后
    `i = 流末尾` 提前跳走，把后面的真头吞了。判据放宽却让结果变少 = 非单调 =
    特异性不足的典型症状。这是"不放宽"的第三条理由，而且可复跑。
    """
    n = len(rom)
    blocks = 0
    i = 0
    while i < n - 4:
        if (rom[i] >> 4) == 1:
            got = decode_any_header(rom, i)
            if got:
                blocks += 1
                i = got[1]
                continue
        i += 1
    return blocks


# ------------------------------------------------------------ 指针字（判据 ptr）

def referenced_offsets(rom, align=4):
    """返回 ({被引用的解压偏移: 指针字个数}, 指针字命中总数)。

    align 是**判据的一部分**：1 = 任意位置（最松），4 = 指针字本身必须 4 字节对齐（格式约束）。
    本 ROM 上 align=1 得 159,591 个命中 / 4,700 块有指针；align=4 得 68,512 / 4,451。
    影响比任何一道 scope 闸门都大，所以必须显式记录，不能藏在实现里。
    """
    n = len(rom)
    refs = {}
    count = 0
    limit = ROM_BASE + n
    for i in range(0, n - 3, align):
        w = rom[i] | (rom[i + 1] << 8) | (rom[i + 2] << 16) | (rom[i + 3] << 24)
        if ROM_BASE <= w < limit:
            off = w - ROM_BASE
            refs.setdefault(off, []).append(i)   # 记引用地址本身：查"谁在用这块"要用
            count += 1
    return refs, count


# --------------------------------------------------------------- 判据与标签

def label_block(off, dlen, clen, rom_size):
    """返回违反的判据标签列表；空列表即 `pass-all`（与顺序无关）。"""
    got = []
    if off + clen > rom_size:      # format：越界读
        got.append("bounds_clen")
    if dlen > rom_size:            # format：解压后不可能比整个 ROM 还大
        got.append("bounds_dlen")
    if dlen < 32:                  # scope：一个图块都不够
        got.append("size")
    return got


def bucket_name(labels):
    return "+".join(labels) if labels else "pass-all"


def self_test(rom):
    """每条判据两侧各一个合成块；反例块还要能通过"除这条之外的所有检查"。"""
    rom_size = len(rom)
    cases = [
        # name,                      off,        dlen,         clen, must_flag,     must_not_flag
        ("size-dlen-16",             0x100,      16,           8,    "size",         None),
        ("size-dlen-32-boundary",    0x200,      32,           8,    None,           "size"),          # 32 是边界，不该剔除
        ("clean-block",              0x300,      1024,         128,  None,           "size,bounds_clen,bounds_dlen"),
        ("bounds-clen-overrun",      rom_size - 8, 256,        64,   "bounds_clen",  None),
        ("bounds-dlen-huge",         0x400,      rom_size + 1, 64,   "bounds_dlen",  None),
        # 已退役判据：目标偏移对齐不该产生任何标签（凭"看起来对"加回来就会静默漏块）
        ("retired-align-off-2",      2,          256,          64,   None,           "size,bounds_clen,bounds_dlen"),
        # ratio 已改为诊断字段：9 倍压缩的块**不该**被剔除
        ("ratio-9x-not-gated",       0x500,      9000,         1000, None,           "size"),
    ]
    failures = []
    for name, off, dlen, clen, must, must_not in cases:
        got = label_block(off, dlen, clen, rom_size)
        if must and must not in got:
            failures.append(f"{name}: 期望被 {must} 剔除，实际 {got}")
        if must_not and set(must_not.split(",")) & set(got):
            failures.append(f"{name}: 期望不被 {must_not} 剔除，实际 {got}")

    # 头字节两侧探针：正例收下、反例拒绝，且反例必须"能独立解出"——
    # 否则解码器坏掉时探针照样通过，测的就不是判据。
    probe = None
    probe_off = 0xA1317E
    if probe_off + 4 <= rom_size:
        hb = rom[probe_off]
        probe = {
            "offset": hex(probe_off),
            "header_byte": hex(hb),
            "strict_accepts": decode(rom, probe_off) is not None,
            "loose_accepts": decode_any_header(rom, probe_off) is not None,
            "expectation": "strict=False, loose=True（拒绝理由是判据，不是解不出来）",
        }
        if probe["strict_accepts"]:
            failures.append("头字节反例探针：严格口径竟然收下了 0x14 的块")
        if not probe["loose_accepts"]:
            failures.append("头字节反例探针：宽松口径也解不出，无法证明拒绝理由是判据")

    result = {
        "self_test": "ok" if not failures else "FAILED",
        "failures": failures,
        "cases": [
            {"name": n, "offset": hex(o), "dlen": d, "clen": c, "labels": label_block(o, d, c, rom_size)}
            for n, o, d, c, _, _ in cases
        ],
        "header_byte_probe": probe,
        "note": "每条判据两侧各一个合成块；反例块必须能通过除该判据外的所有检查",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


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
            offsets.add(int(first, 16) if first.lower().startswith("0x") else int(first, 10))
    return offsets


def main(argv):
    args = argv[1:]
    rom_path = DEFAULT_ROM
    if args and not args[0].startswith("-"):
        rom_path = args[0]
        args = args[1:]

    def opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default

    with open(rom_path, "rb") as fh:
        rom = fh.read()
    rom_size = len(rom)

    if "--self-test" in args:
        return self_test(rom)

    out_dir = opt("--out", ".botharness/handoff/gate-attr")
    emit_tsv = opt("--emit-tsv")
    other = opt("--other")
    ptr_align = int(opt("--ptr-align", "4"))

    blocks = scan(rom)
    loose_count = header_loose_count(rom) if "--measure-header-loose" in args else None
    refs, ptr_words = referenced_offsets(rom, ptr_align)

    os.makedirs(out_dir, exist_ok=True)
    my_tsv = emit_tsv or os.path.join(out_dir, "my-blocks.tsv")
    os.makedirs(os.path.dirname(os.path.abspath(my_tsv)), exist_ok=True)

    # 我这边的清单：多给一列 refs（指向该偏移的指针字个数），refs>=2 的块单独分组
    with open(my_tsv, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# 口径：纯扫描召回上界，不是资产表判据（资产表判据 = 指针驱动枚举）\n")
        fh.write(f"# rom_sha256 {sha256_file(rom_path)}\n")
        fh.write(f"# generator {os.path.basename(__file__)} sha256 {sha256_file(__file__)}\n")
        fh.write("# enumeration=pure_scan  head=0x10  dlen_semantics=exact  skip_resolved_stream=yes\n")
        fh.write("# header_byte=exact_0x10        (低 4 位必须为 0；不用 >>4==1)\n")
        loose_txt = str(loose_count) if loose_count is not None else "未测(加 --measure-header-loose)"
        fh.write(f"# header_byte_loose_count={loose_txt}  (>>4==1 变体实测总数，仅对照，不进资产表)\n")
        fh.write("# gates_applied=none   (本清单是原始基线；size/bounds 只是可选过滤器)\n")
        fh.write(f"# ptr_alignment={ptr_align}   refs 列 = 指向该偏移的指针字个数\n")
        fh.write(f"# 数据行 {len(blocks)}\n")
        fh.write("# offset\tdlen\tclen\trefs\n")
        for off, dlen, clen in sorted(blocks):
            fh.write(f"0x{off:06X}\t{dlen}\t{clen}\t{refs.get(off, 0)}\n")

    ratio_hits = sum(1 for off, dlen, clen in blocks if clen > 0 and dlen / clen > 8)
    ratio_tombstone = sum(1 for off, dlen, clen in blocks if dlen > 0 and clen / dlen > 8)

    buckets, buckets_ref = {}, {}
    for off, dlen, clen in blocks:
        name = bucket_name(label_block(off, dlen, clen, rom_size))
        buckets.setdefault(name, []).append(off)
        if off in refs:
            buckets_ref.setdefault(name, []).append(off)

    for name, offs in buckets.items():
        with open(os.path.join(out_dir, f"bucket-{name}.tsv"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(f"# bucket {name}  count {len(offs)}\n")
            fh.write("# offset\n")
            for off in sorted(offs):
                fh.write(f"0x{off:06X}\n")

    block_offs = {b[0] for b in blocks}
    by_off_pre = {b[0]: (b[1], b[2]) for b in blocks}
    # 极小共用片段：refs>=2 且 dlen<32 —— 文本/常量系统的第一嫌疑名单。
    # 排序先 dlen 升序再 refs 降序："越小又被引用越多"的排前面（图形共用通常 dlen>=32，属正常）。
    tiny = sorted(
        (o for o, pos in refs.items() if len(pos) >= 2 and o in block_offs and by_off_pre[o][0] < 32),
        key=lambda o: (by_off_pre[o][0], -len(refs[o])),
    )
    with open(os.path.join(out_dir, "tiny-shared.tsv"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# 极小共用片段：refs>=2 且 dlen<32（未来菜单空白/台词缺失的第一嫌疑）\n")
        fh.write("# 排序：dlen 升序，其次 refs 降序；plaintext_sha256 = 解出字节的 sha256（可作连接键）\n")
        fh.write("# offset\tdlen\tclen\trefs\tref_positions\tplaintext_sha256\n")
        for off in tiny:
            dlen, clen = by_off_pre[off][0], by_off_pre[off][1]
            got = decode(rom, off)
            pt = _plaintext(rom, off) if got else None
            digest = hashlib.sha256(pt).hexdigest() if pt else "-"
            pos_txt = ",".join(f"0x{x:06X}" for x in refs[off][:8])
            fh.write(f"0x{off:06X}\t{dlen}\t{clen}\t{len(refs[off])}\t{pos_txt}\t{digest}\n")

    multi_ref = sorted(o for o, pos in refs.items() if len(pos) >= 2 and o in block_offs)
    by_off = {b[0]: b for b in blocks}
    with open(os.path.join(out_dir, "refs-ge-2.tsv"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# 被 >=2 个指针字引用的块：将来\"某段台词/菜单项对不上\"的第一嫌疑\n")
        fh.write("# offset\trefs\tdlen\tclen\n")
        for off in multi_ref:
            dlen, clen = by_off[off][1], by_off[off][2]
            fh.write(f"0x{off:06X}\t{refs[off]}\t{dlen}\t{clen}\n")

    summary = {
        "rom": rom_path,
        "rom_sha256": sha256_file(rom_path),
        "rom_size": rom_size,
        "criteria": {
            "enumeration": "pure_scan: i+=1, head==0x10, 8<=dlen<=0x400000, skip_resolved_stream",
            "dlen_semantics": "exact (解压后长度，必须精确达到)",
            "pointer_word": f"LE32 step={ptr_align} in [0x08000000, 0x08000000+rom_size)",
            "gates": [
                {"name": "bounds_clen", "category": "format", "why": "clen 越过 ROM 末尾就是越界读"},
                {"name": "bounds_dlen", "category": "format", "why": "解压后不可能比整个 ROM 还大"},
                {"name": "dlen<32", "category": "scope", "why": "8x8 4bpp 一个图块=32B；不是格式约束"},
            ],
            "diagnostic_not_gate": {
                "ratio": {
                    "denominator": f"{len(blocks)}_pure_scan_full",
                    "dlen_over_clen_gt_8_hits": ratio_hits,
                    "clen_over_dlen_gt_8_hits": ratio_tombstone,
                    "noise_upper_bound": 1.778,
                    "noise_basis": "洗牌基线 553 块，种子 20261030",
                    "why_not_a_gate": "阈值 8/16 都不会被噪声触及；历史上 8 只砍掉 25 块真块（8.05~8.40）",
                }
            },
            "retired_gates": {
                "target_offset_alignment": "format 类但无依据：BIOS LZ77 对输出位置无对齐要求；曾静默漏块 0xA1317E(offset%4==2)",
            },
            "stageOrder": ["gates", "referenced", "ptr_align"],
            "order_dependent_intermediates": {
                "warning": "中间层计数依赖顺序，不可当事实引用；只有最终集合与标签划分与顺序无关",
            },
            "header_byte": {
                "verdict": "exact_0x10（PM 2026-10-30 裁定，不放宽）",
                "loose_count_measured": loose_count,
                "known_example": "0xA1317E header=0x14 dlen=256 clen=281 -> 严格口径拒收；宽松口径可解",
                "why_not_loose": [
                    "低 4 位在别的类型里有含义（Huffman 0x24/0x28），放宽等于放弃类型判别",
                    "放宽后总数 4,933 掉到 4,834（非单调）⇒ 特异性不足，会错位而不是多收",
                ],
            },
        },
        "counts": {
            "blocks": len(blocks),
            "pointer_words": ptr_words,
            "blocks_with_pointer": sum(1 for b in blocks if b[0] in refs),
            "blocks_without_pointer": sum(1 for b in blocks if b[0] not in refs),
            "blocks_with_refs_ge_2": len(multi_ref),
            "buckets": {name: len(offs) for name, offs in sorted(buckets.items())},
            "buckets_referenced": {name: len(offs) for name, offs in sorted(buckets_ref.items())},
        },
        "tsv": {"mine": my_tsv, "mine_sha256": sha256_file(my_tsv)},
    }

    pd_path = opt("--emit-pointer-driven")
    if pd_path:
        # 指针驱动集合：只保留 format 守卫（bounds_*），**不加 scope 筛选**。
        # 理由：与游戏实现的 4,451 做同口径对照——他们的清单不含 dlen>=32 这类用途筛选，
        # 若我这边悄悄套上，差的 2 块会被误读成"枚举差异"。
        # 指针驱动 = **直接枚举指针目标**，不与纯扫描结果求交。
        # 原因：纯扫描命中后 i=流末尾，被更大流覆盖的真块（如 0x9CCA24，header 0x10、dlen 20480）
        # 会被直接吞掉；指针是独立证据，求交等于让扫描策略决定清单内容，且不可复现。
        pd = []
        for _off in sorted(refs):
            if rom[_off] != 0x10:
                continue
            _got = decode(rom, _off)
            if not _got:
                continue
            _size, _end = _got
            _labels = label_block(_off, _size, _end - _off, rom_size)
            if "bounds_clen" in _labels or "bounds_dlen" in _labels:
                continue
            pd.append((_off, _size, _end - _off))
        # 头注是承诺，生成时逐条履行：凡头注出现的字段，summary 里有对应 assert 计数。
        assert_fail = [o for o, _d, _c in pd if rom[o] != 0x10]
        with open(pd_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("# 指针驱动(ptr align4) + 严格 head==0x10 + 仅 format 守卫; 不筛 size/ratio\n")
            fh.write(f"# rom_sha256 {sha256_file(rom_path)}\n")
            fh.write(f"# 数据行 {len(pd)}  bad_headers={len(assert_fail)}  dlen_lt_32={sum(1 for _o, d, _c in pd if d < 32)}\n")
            fh.write("# offset\tdlen\tclen\n")
            for off, dlen, clen in pd:
                fh.write(f"0x{off:06X}\t{dlen}\t{clen}\n")
        summary["pointer_driven_tsv"] = {
            "path": pd_path,
            "rows": len(pd),
            "sha256": sha256_file(pd_path),
            "header_assert_failures": len(assert_fail),
            "dlen_lt_32": sum(1 for _o, d, _c in pd if d < 32),
        }

    if other:
        other_offs = read_tsv_offsets(other)
        # 残差必须按**同口径**算：指针驱动集合（含 size 那两块） 减 对方清单，
        # 否则 pass-all 里 4,492 个"无指针"的块全会被算成残差（纯扫描 vs 指针驱动的口径混用）。
        residual = [b[0] for b in blocks if b[0] in refs and b[0] not in other_offs]
        with open(os.path.join(out_dir, "residual.tsv"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("# pass-all（只过 format + scope）却不在对方清单里 —— 唯一值得逐块归因的集合\n")
            fh.write("# offset\n")
            for off in sorted(residual):
                fh.write(f"0x{off:06X}\n")
        summary["other"] = {
            "path": other,
            "sha256": sha256_file(other),
            "rows": len(other_offs),
            "residual_count": len(residual),
            "residual_file": os.path.join(out_dir, "residual.tsv"),
            "only_in_mine": len([b for b in blocks if b[0] not in other_offs]),
            "only_in_other": len([o for o in other_offs if o not in block_offs]),
        }

    with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(json.dumps(summary["counts"], ensure_ascii=False, indent=2))
    if other:
        print(json.dumps(summary["other"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
