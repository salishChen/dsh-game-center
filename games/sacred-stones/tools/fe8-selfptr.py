"""List self-pointer records and dump the two 128-entry pointer tables.

provenance: emitted by this script; see header comments in the .tsv outputs.
"""
import struct, hashlib, os, sys

ROOT = r"C:\Users\salis\Desktop\dsh-game-boy"
ROM = os.path.join(ROOT, "artifacts", "fe8-remake", "fe8-zh.gba")
OUT = os.path.join(ROOT, "games", "sacred-stones", "extract")
rom = open(ROM, "rb").read()
N = len(rom)


def u32(o):
    return struct.unpack_from("<I", rom, o)[0]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


self_sha = sha(__file__)

# predicate: u32@(t+0xC) high byte 0x08, low24 == t
aligned = []
bytewise = []
for t in range(0, N - 16):
    if (u32(t + 0xC) >> 24) == 0x08 and (u32(t + 0xC) & 0xFFFFFF) == t:
        bytewise.append(t)
        if t % 4 == 0:
            aligned.append(t)

local = sorted(set(aligned))
padded = sorted(set(t for t in bytewise if t % 4 == 0))
shared = sorted(set(local) & set(padded))
onlyA = sorted(set(local) - set(padded))
onlyB = sorted(set(padded) - set(local))
print("bytewise=%d aligned=%d shared=%d onlyA=%d onlyB=%d" % (len(bytewise), len(local), len(shared), len(onlyA), len(onlyB)))

with open(os.path.join(OUT, "selfptr-275.tsv"), "w", encoding="utf-8", newline="\n") as f:
    f.write("# self-pointer list\n")
    f.write("# predicate: u32@(t+0xC) >> 24 == 0x08 and (u32@(t+0xC) & 0xFFFFFF) == t\n")
    f.write("# scan_stride=4  window_start=0  target_align=4  t_definition=record_start\n")
    f.write("# generator=games/sacred-stones/tools/fe8-selfptr.py\n")
    f.write("# generator_sha256=%s\n" % self_sha)
    f.write("# rom_sha256=%s\n" % sha(ROM))
    f.write("# rows=%d\n" % len(local))
    for t in local:
        f.write("%d\n" % t)

with open(os.path.join(OUT, "selfptr-284-bytewise.tsv"), "w", encoding="utf-8", newline="\n") as f:
    f.write("# same predicate, byte-wise stride=1 (window_start=0, target_align=none)\n")
    f.write("# generator_sha256=%s  rows=%d\n" % (self_sha, len(bytewise)))
    for t in sorted(set(bytewise)):
        f.write("%d\n" % t)

# two pointer tables: 128 entries x 8 bytes each, entry = two dwords both pointing to t-8
rows = []
for name, base in (("T1", 0xBB8A8C), ("T2", 0xBC35BC)):
    for i in range(128):
        t = base + i * 8
        w0, w1 = u32(t), u32(t + 4)
        rows.append((name, i, t, w0, w1))

with open(os.path.join(OUT, "ptr-table-256-dump.tsv"), "w", encoding="utf-8", newline="\n") as f:
    f.write("# two ptr-tables, 128 entries x 8 B each; entry = [dword, dword]\n")
    f.write("# t_definition=entry_start; expected: both dwords == 0x08|(t-8); entry 0 of each table = 0\n")
    f.write("# generator_sha256=%s  rows=%d\n" % (self_sha, len(rows)))
    f.write("# table\tindex\toffset\tw0\tw1\tdelta0\tdelta1\n")
    for name, i, t, w0, w1 in rows:
        d0 = (w0 & 0xFFFFFF) - t if (w0 >> 24) == 0x08 else ""
        d1 = (w1 & 0xFFFFFF) - t if (w1 >> 24) == 0x08 else ""
        f.write("%s\t%d\t0x%06X\t0x%08X\t0x%08X\t%s\t%s\n" % (name, i, t, w0, w1, d0, d1))
print("wrote selfptr-275.tsv, selfptr-284-bytewise.tsv, ptr-table-256-dump.tsv")
