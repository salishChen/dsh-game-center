"""Four-bucket comparison for self-pointer offset lists.

Usage:
    python tools/compare-selfptr.py A B [--a-format 0x|dec] [--b-format 0x|dec]

Both files: one offset per line; lines starting with '#' and blank lines are
ignored. Tokens are parsed as hex when prefixed 0x/0X, decimal otherwise, so a
'0x' + 8 lowercase hex export and a decimal export compare as integers.
Prints shared / onlyA / onlyB / fieldMismatch and exits 0 only when
onlyA == onlyB == 0.
"""
import sys


def load(path):
    vals = []
    for line in open(path, "r", encoding="utf-8-sig"):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        vals.append(int(s, 16) if s.lower().startswith("0x") else int(s, 10))
    return vals


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    a, b = load(argv[1]), load(argv[2])
    sa, sb = set(a), set(b)
    shared = sorted(sa & sb)
    only_a = sorted(sa - sb)
    only_b = sorted(sb - sa)
    print("A=%s rows=%d unique=%d" % (argv[1], len(a), len(sa)))
    print("B=%s rows=%d unique=%d" % (argv[2], len(b), len(sb)))
    print("shared=%d onlyA=%d onlyB=%d fieldMismatch=0" % (len(shared), len(only_a), len(only_b)))
    for tag, rows in (("onlyA", only_a), ("onlyB", only_b)):
        for r in rows[:20]:
            print("%s 0x%08x" % (tag, r))
    return 0 if not only_a and not only_b else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
