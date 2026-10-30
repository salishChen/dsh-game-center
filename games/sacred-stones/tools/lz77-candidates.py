#!/usr/bin/env python3
"""LZ77 块枚举 + 闸门标签 + 自检（不自我安装；落盘由外部 cp）。

口径（资产表）：
  enumeration=pointer-driven, ptr_alignment=4, header_byte=exact_0x10,
  dlen_semantics=exact, scope: dlen>=32
diagnostic：ratio（dlen/clen），不参与筛选。
"""
import argparse
import hashlib
import json
import os
import sys

DEFAULT_ROM = r"artifacts/fe8-remake/fe8-zh.gba"
DEFAULT_OUT = r"games/sacred-stones/extract/lz77-candidates.json"
TOOL_SHA = None


def tool_sha256():
    return hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()


def decode(buf, off, rom_size):
    """返回 (dlen, clen) 或 None。守卫：头字节严格 0x10、dlen 精确、clen 不越界、dlen<=ROM。"""
    if off + 4 > rom_size:
        return None
    if buf[off] != 0x10:          # exact_0x10：低 4 位必须为 0
        return None
    dlen = buf[off + 1] | (buf[off + 2] << 8) | (buf[off + 3] << 16)
    if dlen <= 0 or dlen > rom_size:   # format guard: 荒谬声明
        return None
    i = off + 4
    out = bytearray()
    while len(out) < dlen:
        if i >= rom_size:          # format guard: 压缩流越过 ROM 末尾
            return None
        flags = buf[i]
        i += 1
        for b in range(8):
            if len(out) >= dlen:
                break
            if flags & (0x80 >> b):
                if i + 1 >= rom_size:
                    return None
                b0, b1 = buf[i], buf[i + 1]
                i += 2
                length = (b0 >> 4) + 3
                disp = ((b0 & 0x0F) << 8) | b1
                pos = len(out) - disp - 1
                if pos < 0:
                    return None
                for k in range(length):
                    if len(out) >= dlen:
                        break
                    out.append(out[pos + k])
            else:
                if i >= rom_size:
                    return None
                out.append(buf[i])
                i += 1
    return dlen, i - off, bytes(out)


def gate_labels(dlen, clen):
    L = []
    if dlen < 32:
        L.append("dlen<32")
    return L


def self_test(rom_size):
    cases = []
    cases.append({"name": "keep-32x32", "dlen": 32, "clen": 32, "expect": []})
    cases.append({"name": "drop-dlen", "dlen": 31, "clen": 100, "expect": ["dlen<32"]})
    cases.append({"name": "keep-expansion", "dlen": 256, "clen": 281, "expect": []})
    ok = all(gate_labels(c["dlen"], c["clen"]) == c["expect"] for c in cases)

    # 守卫探针：用合成 buffer 走真实 decode
    hdr = lambda dlen: bytes([0x10, dlen & 0xFF, (dlen >> 8) & 0xFF, (dlen >> 16) & 0xFF])
    probes = []

    buf = hdr(64) + b"\x00" * 8                      # 声明 64 字节但数据远不足
    probes.append({"name": "clen-crosses-eof", "rejected": decode(buf, 0, len(buf)) is None})

    buf2 = hdr(65) + b"\x00" * 8                     # dlen=65 > rom_size=64+8? 用 64 的 rom_size
    probes.append({"name": "dlen-gt-romsize", "rejected": decode(buf2, 0, 64) is None})

    buf3 = bytes([0x14]) + hdr(32)[1:] + b"\x00" * 8  # 头字节 0x14 必须拒
    probes.append({"name": "header-0x14-rejected", "rejected": decode(buf3, 0, len(buf3)) is None})

    return {"ok": ok and all(p["rejected"] for p in probes), "cases": cases, "probes": probes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rom", nargs="?", default=DEFAULT_ROM)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    rom = open(args.rom, "rb").read()
    n = len(rom)

    st = self_test(n)
    if args.self_test:
        print(json.dumps(st, indent=1, ensure_ascii=False))
        return 0 if st["ok"] else 1

    refs = {}
    for p in range(0, n - 3, 4):
        w = rom[p] | (rom[p + 1] << 8) | (rom[p + 2] << 16) | (rom[p + 3] << 24)
        if (w >> 24) != 0x08:
            continue
        off = w & 0xFFFFFF
        if off < n:
            refs[off] = refs.get(off, 0) + 1

    rows = []
    for off in sorted(refs):
        r = decode(rom, off, n)
        if not r:
            continue
        dlen, clen, data = r
        rows.append({
            "offset": "0x%06X" % off,
            "dlen": dlen,
            "clen": clen,
            "refs": refs[off],
            "content_sha256": hashlib.sha256(data).hexdigest(),
            "gates": gate_labels(dlen, clen),
        })

    keep = [r for r in rows if not r["gates"]]
    summary = {
        "tool": {"path": os.path.relpath(os.path.abspath(__file__)),
                 "sha256": tool_sha256()},
        "self_test": dict(st, invocation=" ".join(sys.argv),
                          cwd=os.getcwd(),
                          mode="in-repo" if os.path.abspath(__file__).startswith(os.getcwd()) else "handoff"),
        "rom": {"path": args.rom, "size": n,
                "sha256": hashlib.sha256(rom).hexdigest()},
        "total_blocks": len(rows),
        "asset_table_ready": len(keep),
        "join_key": "content_sha256",
        "note": "本文件是候选集（含 refs 与解出内容 sha256）；验收集由 VRAM oracle 产出，按 content_sha256 连接",
    }
    json.dump({"summary": summary, "blocks": rows}, open(args.out, "w", encoding="utf-8"), indent=1)
    print(json.dumps({"total": len(rows), "asset_table_ready": len(keep),
                      "self_test_ok": st["ok"], "out": args.out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
