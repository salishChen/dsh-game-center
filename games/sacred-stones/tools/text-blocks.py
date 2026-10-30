"""Screen LZ77 blocks for text-like content.

Witness first, conclusion second:
  - candidate blocks      : rows with dlen >= 32
  - blocks with 0x0A/0x0B : control-code candidates
  - byte-range profile    : min / max byte, distinct byte count
  - max index             : lower bound for a font table (max+1 glyp ht count)

Usage: python tools/text-blocks.py extract/lz77-pointers-4454.tsv extract/text-blocks-summary.json
"""
import json
import os
import sys

ROM = r"artifacts/fe8-remake/fe8-zh.gba"


def decompress(rom, off, want):
    if rom[off] != 0x10:
        return None
    size = rom[off + 1] | (rom[off + 2] << 8) | (rom[off + 3] << 16)
    if size != want:
        return None
    src = off + 4
    out = bytearray()
    while len(out) < size:
        flags = rom[src]
        src += 1
        for i in range(8):
            if len(out) >= size:
                break
            if flags & (0x80 >> i):
                b1 = rom[src]
                b2 = rom[src + 1]
                src += 2
                length = (b1 >> 4) + 3
                disp = (((b1 & 0x0F) << 8) | b2) + 1
                for _ in range(length):
                    out.append(out[len(out) - disp])
                    if len(out) >= size:
                        break
            else:
                out.append(rom[src])
                src += 1
    return bytes(out[:size])


def main(tsv_path, out_path):
    rom = open(ROM, "rb").read()
    rows = []
    for line in open(tsv_path, encoding="utf-8"):
        if line.startswith("#") or not line.strip():
            continue
        off, dlen, clen = (int(x) for x in line.split()[:3])
        rows.append((off, dlen, clen))
    cand = [(o, d, c) for o, d, c in rows if d >= 32]
    results = []
    for off, dlen, clen in cand:
        data = decompress(rom, off, dlen)
        if data is None:
            continue
        mx = max(data)
        results.append({
            "offset": off,
            "dlen": dlen,
            "clen": clen,
            "has_0A": 0x0A in data,
            "has_0B": 0x0B in data,
            "min_byte": min(data),
            "max_byte": mx,
            "distinct_bytes": len(set(data)),
            "printable_ratio": round(sum(0x20 <= b <= 0x7E for b in data) / len(data), 4),
            "head_hex": data[:16].hex(),
        })
    ctrl = [r for r in results if r["has_0A"] or r["has_0B"]]
    both = [r for r in results if r["has_0A"] and r["has_0B"]]
    summary = {
        "candidates_ge32": len(cand),
        "decoded": len(results),
        "blocks_with_0A_or_0B": len(ctrl),
        "blocks_with_both": len(both),
        "max_byte_overall": max(r["max_byte"] for r in results) if results else None,
        "ctrl_max_byte": max((r["max_byte"] for r in ctrl), default=None),
        "ctrl_max_min": max((r["min_byte"] for r in ctrl), default=None),
        "top_ctrl": sorted(ctrl, key=lambda r: (-r["has_0A"] - r["has_0B"], -r["dlen"]))[:40],
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("candidates_ge32:", summary["candidates_ge32"])
    print("decoded:", summary["decoded"])
    print("blocks_with_0A_or_0B:", summary["blocks_with_0A_or_0B"], "both:", summary["blocks_with_both"])
    print("max_byte_overall:", summary["max_byte_overall"], "ctrl_max_byte:", summary["ctrl_max_byte"])
    for r in summary["top_ctrl"][:5]:
        print("  off=0x%06X dlen=%d max=%02X distinct=%d head=%s" % (r["offset"], r["dlen"], r["max_byte"], r["distinct_bytes"], r["head_hex"]))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
