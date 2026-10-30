"""Verify self_sha256 of a frame dump.

Definition (the only one):
    self_sha256 = sha256(file bytes with the self_sha256 value replaced by 64 '0')

Usage: python tools/frame900-selfcheck.py extract/frame900.json
"""
import hashlib
import json
import re
import sys


def main(path):
    raw = open(path, "rb").read()
    text = raw.decode("utf-8")
    declared = json.loads(text)["self_sha256"]
    normalized = re.sub(r'("self_sha256"\s*:\s*")[0-9a-fA-F]{64}(")', r"\g<1>" + "0" * 64 + r"\g<2>", text)
    got = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    print("declared   :", declared)
    print("recomputed :", got)
    print("self_verify:", got == declared)
    return 0 if got == declared else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "extract/frame900.json"))
