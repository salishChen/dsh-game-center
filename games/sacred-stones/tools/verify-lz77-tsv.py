#!/usr/bin/env python3
"""Verify an LZ77 pointer table (tsv) against the ROM, and stamp assert counts into its header.

Independence: this decoder is written separately from tools/lz77-candidates.py.
Same semantics: pointer row (offset,dlen,clen), header byte exact 0x10, dlen exact,
truncating tail allowed, clen = bytes consumed.

Usage:
  python tools/verify-lz77-tsv.py extract/lz77-pointers-4454.tsv --write-header
"""
import argparse
import os

ROM_DEFAULT = r"artifacts/fe8-remake/fe8-zh.gba"


def decode(rom, off, rom_size):
    if off + 4 > rom_size:
        return None
    if rom[off] != 0x10:
        return None
    dlen = rom[off + 1] | (rom[off + 2] << 8) | (rom[off + 3] << 16)
    if dlen <= 0 or dlen > rom_size:
        return None
    i = off + 4
    out = 0
    while out < dlen:
        if i >= rom_size:
            return None
        flags = rom[i]
        i += 1
        for b in range(8):
            if out >= dlen:
                break
            if i >= rom_size:
                return None
            if flags & (0x80 >> b):
                if i + 1 >= rom_size:
                    return None
                b0, b1 = rom[i], rom[i + 1]
                i += 2
                ln = (b0 >> 4) + 3
                disp = ((b0 & 0x0F) << 8) | b1
                pos = out - disp - 1
                if pos < 0:
                    return None
                out += ln
            else:
                i += 1
                out += 1
    return dlen, i - off


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tsv")
    ap.add_argument("--rom", default=ROM_DEFAULT)
    ap.add_argument("--write-header", action="store_true")
    args = ap.parse_args()

    rom = open(args.rom, "rb").read()
    rom_size = len(rom)
    text = open(args.tsv, encoding="utf-8").read().splitlines()
    header = [l for l in text if l.startswith("#")]
    rows = [l for l in text if (not l.startswith("#")) and l.strip()]

    bad_headers = 0
    fails = 0
    below = 0
    samples = []
    for line in rows:
        f = line.split("\t")
        off = int(f[0], 16)
        dlen = int(f[1])
        clen = int(f[2])
        if rom[off] != 0x10:
            bad_headers += 1
        got = decode(rom, off, rom_size)
        if got is None or got[0] != dlen or got[1] != clen:
            fails += 1
            if len(samples) < 5:
                samples.append((hex(off), dlen, clen, got))
        if dlen < 32:
            below += 1

    print(f"file={args.tsv}")
    print(f"rows={len(rows)} bad_headers={bad_headers} header_assert_failures={fails} scope_below={below}")
    if samples:
        print("samples:", samples)

    if args.write_header:
        keep = [l for l in header if not l.startswith("# dlen_exact=") and not l.startswith("# assert_counts:")]
        stamp = [
            "# dlen_exact=true",
            f"# assert_counts: bad_headers={bad_headers} header_assert_failures={fails} skipped_scope={below}",
        ]
        out = []
        placed = False
        for l in keep:
            if l.startswith("# rows=") and not placed:
                out.extend(stamp)
                placed = True
            out.append(l)
        if not placed:
            out.extend(stamp)
        out.extend(rows)
        with open(args.tsv, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(out) + "\n")
        print(f"header stamped -> {args.tsv}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
