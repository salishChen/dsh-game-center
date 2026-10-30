#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FE8 GBA ROM: LZ77 指针引用枚举 + 洗牌基线（只读）。

判据（与 project 契约一致）：
  - 头字节高 4 位 == 1 (0x10) 才是 LZ77；低 4 位为保留。
  - dlen = bytes[1:4] 小端；8 <= dlen <= 4 MiB。
  - 严格解压：不越过文件尾、回引不越界、输出长度必须恰好等于 dlen。

两种口径：
  A) 指针枚举：扫描 4 字节小端字，0x08000000 <= w < 0x08000000+size，
     指向偏移 off=w-0x08000000，off 处能严格解出 LZ77 -> 记一个引用。
  B) 洗牌基线：同一算法在固定种子打乱的 ROM 上再跑一遍，估计假阳性率。

输出：JSON（--out）+ 控制台摘要。
"""
import sys, os, json, hashlib, random, argparse

BASE = 0x08000000


def lz77_strict(rom, i):
    n = len(rom)
    if i + 4 > n:
        return None
    if (rom[i] >> 4) != 1:
        return None
    size = rom[i + 1] | (rom[i + 2] << 8) | (rom[i + 3] << 16)
    if not (8 <= size <= 0x400000):
        return None
    out_len = 0
    p = i + 4
    while out_len < size:
        if p >= n:
            return None
        flags = rom[p]
        p += 1
        for bit in range(8):
            if out_len >= size:
                break
            if flags & (0x80 >> bit):
                if p + 2 > n:
                    return None
                b1 = rom[p]
                b2 = rom[p + 1]
                p += 2
                ln = (b1 >> 4) + 3
                disp = ((b1 & 0x0F) << 8) | b2
                if out_len - disp - 1 < 0:
                    return None
                out_len += ln
            else:
                if p >= n:
                    return None
                p += 1
                out_len += 1
    if out_len != size:
        return None
    return (i, p, size)


def enumerate_pointers(rom):
    n = len(rom)
    offs = {}
    words = 0
    for k in range(0, n - 3, 4):
        w = rom[k] | (rom[k + 1] << 8) | (rom[k + 2] << 16) | (rom[k + 3] << 24)
        if BASE <= w < BASE + n - 3:
            words += 1
            off = w - BASE
            if off in offs:
                offs[off]["refs"] += 1
                continue
            r = lz77_strict(rom, off)
            if r:
                offs[off] = {"offset": off, "decompressed_size": r[2],
                             "compressed_size": r[1] - r[0], "end_offset": r[1],
                             "refs": 1}
    return words, offs


def summarize(name, rom, out):
    n = len(rom)
    words, offs = enumerate_pointers(rom)
    uniq = len(offs)
    total_d = sum(v["decompressed_size"] for v in offs.values())
    total_c = sum(v["compressed_size"] for v in offs.values())
    out[name] = {
        "rom_size": n,
        "words_in_gba_range": words,
        "unique_valid_offsets": uniq,
        "total_refs": sum(v["refs"] for v in offs.values()),
        "total_compressed_bytes": total_c,
        "total_decompressed_bytes": total_d,
        "ratio_compressed_over_decompressed": (round(total_c / total_d, 4) if total_d else None),
        "top20_by_size": sorted(
            [{"offset_hex": "0x%06X" % v["offset"], "dlen": v["decompressed_size"],
              "clen": v["compressed_size"], "refs": v["refs"]} for v in offs.values()],
            key=lambda x: -x["dlen"])[:20],
    }
    print("%-8s words=%-7d unique_offsets=%-6d refs=%-6d clen=%-9d dlen=%-9d ratio=%s" % (
        name, words, uniq, out[name]["total_refs"], total_c, total_d,
        out[name]["ratio_compressed_over_decompressed"]))
    return out[name]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rom", nargs="?", default="artifacts/fe8-remake/fe8-zh.gba")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=20261030)
    args = ap.parse_args()

    rom = open(args.rom, "rb").read()
    out = {"rom": {"path": args.rom, "size": len(rom),
                   "sha256": hashlib.sha256(rom).hexdigest()},
           "criterion": "high-nibble==1, strict decode, exact dlen, pointer 0x08xxxxxx"}

    summarize("REAL", rom, out)

    shuf = bytearray(rom)
    random.Random(args.seed).shuffle(shuf)
    summarize("SHUFFLED", bytes(shuf), out)
    out["seed"] = args.seed

    d = os.path.dirname(os.path.abspath(args.out))
    if d:
        os.makedirs(d, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("wrote:", args.out)


if __name__ == "__main__":
    main()
