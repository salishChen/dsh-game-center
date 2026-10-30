#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fe8_scan.py -- 火炎之纹章 FE8(汉化) GBA ROM 静态数据面扫描

用途：一次运行产出本批任务的第 1/2/3/4 问全部数字。
     只读 ROM，只写一个 JSON。

用法：
    python fe8_scan.py artifacts/fe8-remake/fe8-zh.gba --out extract/fe8-rom-facts.json
    python fe8_scan.py --help

依赖：仅标准库（numpy 可选，用于加速，缺了也能跑）。

设计原则（重要，别改成"看起来更好看"的版本）：
  * 任何压缩流必须真正解压成功、长度精确等于头里声明的大小，才算"合法"。
    只做头部形状判断的，一律记为 candidates，不记入 valid。
  * 解压器遇到任何越界/非法回指立刻放弃，返回 None，绝不返回半截数据。
  * ROM 以 'rb' 打开，全程不写回。
"""

import argparse
import json
import math
import os
import sys
from collections import Counter

# ---------------------------------------------------------------- GBA 表头

NINTENDO_LOGO_REF = (
    "24 FF AE 51 69 9A A2 21 3D 84 82 0A 84 E4 09 AD 11 24 8B 98 C0 81 7F 21 "
    "A3 52 BE 19 93 09 CE 20 10 46 4A 4A F8 27 31 EC 58 C7 E8 33 82 E3 CE BF "
    "85 F4 DF 94 CE 4B 09 C1 94 56 8A C0 13 72 A7 FC 9F 84 4D 73 A3 CA 9A 61 "
    "58 97 A3 27 FC 03 98 76 23 1D C7 61 03 04 AE 56 BF 38 84 00 40 A7 0E FD "
    "FF 52 FE 03 6F 95 30 F1 97 FB C0 85 60 D6 80 25 A9 63 BE 03 01 4E 38 E2 "
    "F9 A2 34 FF BB 3E 03 44 78 00 90 CB 88 11 3A 94 65 C0 7C 63 87 F0 3C AF "
    "D6 25 E4 8B 38 0A AC 72 21 D4 F8 07 00 00 00 00 00 00 00 00 00 00 00 00"
)


def _ascii(b):
    return b.decode("ascii", "replace").rstrip("\x00")


def parse_header(rom):
    h = rom[:0x200]
    w0 = int.from_bytes(h[0:4], "little")
    op = (w0 >> 24) & 0xFF          # 高字节是 opcode（小端读入后在高位）
    imm24 = w0 & 0xFFFFFF
    if op == 0xEA and imm24 & 0x800000:
        imm24 -= 0x1000000          # 24 位有符号
    target = (0x08 + imm24 * 4) & 0xFFFFFFFF if op == 0xEA else None

    sm = sum(h[0xA0:0xBD])
    calc = (-(sm + 0x19)) & 0xFF

    logo_actual = h[0x04:0xA0]
    logo_ref = bytes.fromhex(NINTENDO_LOGO_REF.replace(" ", ""))[:156]

    return {
        "entry": {
            "raw_hex": h[0:4].hex(" "),
            "opcode": "ARM B (0xEA)" if op == 0xEA else "opcode=0x%02X 非分支" % op,
            "imm24": imm24,
            "target": ("0x%08X" % target) if target is not None else None,
            "arithmetic": "0x08 + %d*4 = 0x%X" % (imm24, 0x08 + imm24 * 4),
            "rom_base_target": ("0x08%06X" % target) if target is not None else None,
        },
        "nintendo_logo_0x04_0x9F": {
            "bytes": 156,
            "matches_reference": logo_actual == logo_ref,
        },
        "title_0xA0": _ascii(h[0xA0:0xAC]),
        "game_code_0xAC": _ascii(h[0xAC:0xB0]),
        "maker_code_0xB0": _ascii(h[0xB0:0xB2]),
        "fixed_0xB2": h[0xB2],
        "main_unit_code_0xB3": h[0xB3],
        "device_type_0xB4": h[0xB4],
        "reserved_0xB5_0xBB": h[0xB5:0xBC].hex(" "),
        "software_version_0xBC": h[0xBC],
        "header_complement_0xBD": h[0xBD],
        "reserved_0xBE_0xBF": h[0xBE:0xC0].hex(" "),
        "checksum": {
            "sum_0xA0_0xBC": sm,
            "computed": calc,
            "stored": h[0xBD],
            "pass": calc == h[0xBD],
        },
    }


# ------------------------------------------------------- 备份库字符串（存档类型）

BACKUP_SIGS = [
    b"EEPROM_V",
    b"SRAM_V",
    b"SRAM_F_V",
    b"FLASH_V",
    b"FLASH512_V",
    b"FLASH1M_V",
]

SAVE_SEMANTICS = [
    # (判定子串, 类型, 容量字节, 依据)
    (b"FLASH1M_V", "FLASH", 128 * 1024, "FLASH1M_V = 1 Mbit FLASH"),
    (b"FLASH512_V", "FLASH", 64 * 1024, "FLASH512_V = 512 Kbit FLASH"),
    (b"FLASH_V", "FLASH", 64 * 1024, "FLASH_V = 512 Kbit FLASH（同 FLASH512_V）"),
    (b"EEPROM_V", "EEPROM", 8 * 1024, "EEPROM_V = 512 Kbit EEPROM（容量见下，需按访问宽度再判）"),
    (b"SRAM_F_V", "SRAM", 32 * 1024, "SRAM_F_V = 256 Kbit SRAM（3.0V 电压）"),
    (b"SRAM_V", "SRAM", 32 * 1024, "SRAM_V = 256 Kbit SRAM"),
]


def scan_backup_sigs(rom):
    hits = []
    for sig in BACKUP_SIGS:
        start = 0
        while True:
            i = rom.find(sig, start)
            if i < 0:
                break
            # 取一段可读上下文（库字符串后面通常跟版本号）
            ctx = rom[i:i + 24]
            printable = "".join(chr(c) if 32 <= c < 127 else "." for c in ctx)
            hits.append({
                "signature": sig.decode("ascii"),
                "offset": i,
                "offset_hex": "0x%06X" % i,
                "context_ascii": printable,
            })
            start = i + 1

    hits.sort(key=lambda x: x["offset"])

    # 取最具体的那个签名做判定（长串优先）
    verdict = None
    for sub, kind, size, why in SAVE_SEMANTICS:
        if any(h["signature"].encode() == sub or sub in h["signature"].encode()
               for h in hits):
            verdict = {"save_type": kind, "capacity_bytes": size,
                       "capacity_human": "%d KiB" % (size // 1024),
                       "basis": why, "matched_signature": sub.decode("ascii")}
            break

    return {
        "present": sorted({h["signature"] for h in hits}),
        "absent": [s.decode() for s in BACKUP_SIGS
                   if not any(h["signature"] == s.decode() for h in hits)],
        "hits": hits,
        "verdict": verdict,
    }


# --------------------------------------------------- GBA BIOS 压缩流（SWI 0x11/0x12/0x13）

def _hdr_size(rom, i):
    """4 字节头：byte0 低 4 位=类型，byte1..3 = 24 位小端解压尺寸。"""
    if i + 4 > len(rom):
        return None
    return rom[i + 1] | (rom[i + 2] << 8) | (rom[i + 3] << 16)


def lz77_decode(rom, i):
    """返回 dict 或 None。i 指向流首字节。"""
    if i + 4 > len(rom) or (rom[i] >> 4) != 1:
        return None
    size = _hdr_size(rom, i)
    if not (8 <= size <= 0x400000):
        return None
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
                src = len(out) - disp - 1
                if src < 0:
                    return None
                for k in range(length):
                    if len(out) >= size:
                        break
                    if src + k >= len(out):
                        return None
                    out.append(out[src + k])
            else:
                if p >= n:
                    return None
                out.append(rom[p])
                p += 1
    if len(out) != size:
        return None
    return {"type": "LZ77", "offset": i, "decompressed_size": size, "end_offset": p}


def rle_decode(rom, i):
    if i + 4 > len(rom) or (rom[i] >> 4) != 3:
        return None
    size = _hdr_size(rom, i)
    if not (8 <= size <= 0x400000):
        return None
    out = bytearray()
    p = i + 4
    n = len(rom)
    while len(out) < size:
        if p >= n:
            return None
        flag = rom[p]
        p += 1
        if flag & 0x80:                      # 重复字节
            ln = (flag & 0x7F) + 3
            if p >= n or len(out) + ln > size:
                return None
            out.extend(bytes([rom[p]]) * ln)
            p += 1
        else:                                 # 原样拷贝
            ln = (flag & 0x7F) + 1
            if p + ln > n or len(out) + ln > size:
                return None
            out.extend(rom[p:p + ln])
            p += ln
    if len(out) != size:
        return None
    return {"type": "RLE", "offset": i, "decompressed_size": size, "end_offset": p}


def huffman_decode(rom, i):
    """GBA Huffman：byte0 高 4 位 = 树大小/4，字段同 LZ77。
    节点 4 字节：node[0]==0 -> 叶，node[1]=符号；
                 node[0]!=0 -> 分支，u16@node+2 = 左子树偏移（相对树起点）；
                 右子树紧接左子树之后（按深度优先存放）。
    """
    if i + 4 > len(rom) or (rom[i] >> 4) != 2:
        return None
    tree_bytes = (rom[i] >> 4) * 4
    if tree_bytes < 4:
        return None
    size = _hdr_size(rom, i)
    if not (8 <= size <= 0x400000):
        return None
    tree = i + 4
    data_start = tree + tree_bytes
    if data_start + 1 > len(rom):
        return None
    if tree + tree_bytes > len(rom):
        return None

    def subtree_end(off):
        """返回以 off 为根的子树结束后的偏移；非法返回 None。"""
        stack = [off]
        seen = 0
        cur = off
        # 迭代：中序不是必须，递归下降求"最深右边界"
        def walk(o, depth=0):
            if depth > 64 or o < 0 or o + 4 > tree + tree_bytes:
                return None
            flag = rom[tree + o]
            if flag == 0:
                return o + 4
            left = rom[tree + o + 2] | (rom[tree + o + 3] << 8)
            le = walk(left, depth + 1)
            if le is None:
                return None
            return walk(le, depth + 1)
        return walk(off)

    total = subtree_end(0)
    if total is None or total > tree_bytes:
        return None

    out = bytearray()
    p = data_start
    n = len(rom)
    bitpos = 0
    node = 0
    while len(out) < size:
        if p >= n:
            return None
        byte = rom[p]
        for b in range(8):
            bit = (byte >> (7 - b)) & 1
            if rom[tree + node] == 0:
                out.append(rom[tree + node + 1])
                node = 0
                if len(out) >= size:
                    break
                # 该位没有消耗节点，需要重新处理 —— 简化：先退位再前进
            # 走分支
            if rom[tree + node] != 0:
                left = rom[tree + node + 2] | (rom[tree + node + 3] << 8)
                le = subtree_end(left)
                if le is None:
                    return None
                node = left if bit == 0 else le
            else:
                # 已达叶：输出并回到根，用同一位继续
                out.append(rom[tree + node + 1])
                node = 0
                if len(out) >= size:
                    break
        p += 1

    if len(out) < size:
        return None
    return {"type": "Huffman", "offset": i, "decompressed_size": size,
            "end_offset": p, "tree_bytes": tree_bytes}


DECODERS = [("LZ77", 0x10, lz77_decode),
            ("RLE", 0x30, rle_decode)]

SIZE_BUCKETS = [
    (8, 64), (64, 256), (256, 1024), (1024, 4096),
    (4096, 16384), (16384, 65536), (65536, 262144), (262144, 1 << 32),
]


def bucket_of(n):
    for lo, hi in SIZE_BUCKETS:
        if lo <= n < hi:
            return "%d-%s" % (lo, "inf" if hi >= (1 << 32) else hi - 1)
    return "other"


def scan_compression(rom, limit_scan_bytes=None, max_report=20):
    n = len(rom) if limit_scan_bytes is None else min(len(rom), limit_scan_bytes)
    result = {}
    for name, first_byte, fn in DECODERS:
        hits = []
        candidates = 0
        pos = 0
        # 用 find 快速定位候选首字节，避免逐字节 Python 循环
        needle = bytes([first_byte])
        while True:
            i = rom.find(needle, pos, n)
            if i < 0:
                break
            pos = i + 1
            candidates += 1
            r = fn(rom, i)
            if r is not None:
                hits.append(r)
        hist = Counter(bucket_of(h["decompressed_size"]) for h in hits)
        result[name] = {
            "header_candidates": candidates,
            "valid_streams": len(hits),
            "covered_bytes": sum(h["end_offset"] - h["offset"] for h in hits),
            "histogram": dict(sorted(hist.items())),
            "first_%d_by_offset" % max_report: [
                {"offset": h["offset"], "offset_hex": "0x%06X" % h["offset"],
                 "decompressed_size": h["decompressed_size"]}
                for h in hits[:max_report]
            ],
            "largest_10": [
                {"offset": h["offset"], "offset_hex": "0x%06X" % h["offset"],
                 "decompressed_size": h["decompressed_size"]}
                for h in sorted(hits, key=lambda x: -x["decompressed_size"])[:10]
            ],
        }
    return result


# ------------------------------------------------------------------ 熵 / 结构

def shannon(buf):
    if not buf:
        return 0.0
    c = Counter(buf)
    n = len(buf)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def entropy_map(rom, block=4096, high=7.2, low=1.0):
    blocks = []
    for off in range(0, len(rom), block):
        blocks.append((off, shannon(rom[off:off + block])))

    def runs(pred):
        out = []
        cur = None
        for off, e in blocks:
            if pred(e):
                if cur is None:
                    cur = {"offset": off, "length": 0, "min": e, "max": e}
                cur["length"] += block
                cur["min"] = min(cur["min"], e)
                cur["max"] = max(cur["max"], e)
            else:
                if cur is not None:
                    out.append(cur)
                    cur = None
        if cur is not None:
            out.append(cur)
        return sorted(out, key=lambda x: -x["length"])

    high_runs = runs(lambda e: e >= high)
    low_runs = runs(lambda e: e <= low)

    # 尾部零填充：从末尾往前找第一个非零块
    last_nonzero = 0
    for off in range(0, len(rom), block):
        if any(rom[off:off + block]):
            last_nonzero = off + block

    return {
        "block_size": block,
        "thresholds": {"high": high, "low": low},
        "file_entropy": round(shannon(rom), 4),
        "block_entropy_mean": round(sum(e for _, e in blocks) / len(blocks), 4),
        "high_runs_top20": [
            {"offset": r["offset"], "offset_hex": "0x%06X" % r["offset"],
             "length": r["length"], "min": round(r["min"], 4), "max": round(r["max"], 4)}
            for r in high_runs[:20]
        ],
        "low_runs_top20": [
            {"offset": r["offset"], "offset_hex": "0x%06X" % r["offset"],
             "length": r["length"], "min": round(r["min"], 4), "max": round(r["max"], 4)}
            for r in low_runs[:20]
        ],
        "high_block_count": sum(1 for _, e in blocks if e >= high),
        "low_block_count": sum(1 for _, e in blocks if e <= low),
        "total_blocks": len(blocks),
        "last_nonzero_block_end": last_nonzero,
        "tail_zero_bytes": len(rom) - last_nonzero,
    }


# ---------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description="FE8 GBA ROM 静态数据面扫描")
    ap.add_argument("rom", nargs="?", default="artifacts/fe8-remake/fe8-zh.gba")
    ap.add_argument("--out", default="extract/fe8-rom-facts.json")
    ap.add_argument("--scan-bytes", type=int, default=None,
                    help="只扫前 N 字节（调试用，默认全文件）")
    ap.add_argument("--skip-compression", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.isfile(args.rom):
        print("找不到 ROM: %s" % args.rom, file=sys.stderr)
        return 2

    with open(args.rom, "rb") as f:
        rom = f.read()

    import hashlib
    out = {
        "schema": "fe8-rom-facts/1",
        "file": {
            "path": args.rom,
            "size_bytes": len(rom),
            "sha256": hashlib.sha256(rom).hexdigest(),
        },
        "header": parse_header(rom),
        "backup": scan_backup_sigs(rom),
        "entropy": entropy_map(rom),
    }

    if not args.skip_compression:
        out["compression"] = scan_compression(rom, args.scan_bytes)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    # 控制台摘要
    h = out["header"]
    print("size      : %d bytes" % out["file"]["size_bytes"])
    print("sha256    : %s" % out["file"]["sha256"])
    print("title     : %s | code %s | maker %s" %
          (h["title_0xA0"], h["game_code_0xAC"], h["maker_code_0xB0"]))
    print("entry     : %s -> %s" % (h["entry"]["raw_hex"], h["entry"]["target"]))
    print("checksum  : computed 0x%02X stored 0x%02X -> %s" %
          (h["checksum"]["computed"], h["checksum"]["stored"],
           "PASS" if h["checksum"]["pass"] else "FAIL"))
    if out["backup"]["verdict"]:
        v = out["backup"]["verdict"]
        print("save      : %s %s (%s)" % (v["save_type"], v["capacity_human"],
                                          v["matched_signature"]))
    for sig in out["backup"]["hits"]:
        print("  sig     : %-14s at 0x%06X  %s" %
              (sig["signature"], sig["offset"], sig["context_ascii"]))
    if "compression" in out:
        for k, v in out["compression"].items():
            print("compress  : %-8s valid=%-6d candidates=%-7d covered=%d B" %
                  (k, v["valid_streams"], v["header_candidates"], v["covered_bytes"]))
    e = out["entropy"]
    print("entropy   : file %.4f | high blocks %d/%d | tail zero %d B" %
          (e["file_entropy"], e["high_block_count"], e["total_blocks"],
           e["tail_zero_bytes"]))
    print("wrote     : %s" % args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
