# 图块资产表（严格口径：头字节 == 0x10 且 dlen>=32）
# 输入：ROM、extract/lz77-candidates.json、extract/frame900.json（vram_base64，带 vram_sha256）
# 输出：extract/tile-assets.tsv、extract/tile-assets-summary.json
# 附带：未匹配 VRAM 图块的"明文 blob"二分搜索（ROM 里有没有这 32 字节）
import base64, hashlib, json, os

ROOT = r"C:\Users\salis\Desktop\dsh-game-boy"
ROM = os.path.join(ROOT, "artifacts/fe8-remake/fe8-zh.gba")
CAND = os.path.join(ROOT, "games/sacred-stones/extract/lz77-candidates.json")
DUMP = os.path.join(ROOT, "games/sacred-stones/extract/frame900.json")
OUT_TSV = os.path.join(ROOT, "games/sacred-stones/extract/tile-assets.tsv")
OUT_JSON = os.path.join(ROOT, "games/sacred-stones/extract/tile-assets-summary.json")
SCOPE_DLEN = 32


def lz77(rom, off):
    if off + 4 > len(rom) or rom[off] != 0x10:
        return None
    dlen = rom[off + 1] | (rom[off + 2] << 8) | (rom[off + 3] << 16)
    if dlen == 0 or dlen > len(rom):
        return None
    out = bytearray()
    i = off + 4
    n = len(rom)
    while len(out) < dlen:
        if i >= n:
            return None
        flags = rom[i]
        i += 1
        for bit in range(7, -1, -1):
            if len(out) >= dlen:
                break
            if flags & (1 << bit):
                if i + 2 > n:
                    return None
                b1 = rom[i]
                b2 = rom[i + 1]
                i += 2
                ln = (b1 >> 4) + 3
                disp = ((b1 & 0x0F) << 8) | b2
                src = len(out) - disp - 1
                if src < 0:
                    return None
                for k in range(ln):
                    if len(out) >= dlen:
                        break
                    out.append(out[src + k])
            else:
                if i >= n:
                    return None
                out.append(rom[i])
                i += 1
    return bytes(out[:dlen])


def main():
    rom = open(ROM, "rb").read()
    d = json.load(open(DUMP, encoding="utf-8"))
    vram = base64.b64decode(d["vram_base64"])
    vram_sha = hashlib.sha256(vram).hexdigest()
    slots, slot_bytes = {}, {}
    for t in range(0, len(vram) - 31, 32):
        tile = vram[t:t + 32]
        if len(set(tile)) <= 1:
            continue
        h = hashlib.sha256(tile).hexdigest()
        slots[h] = slots.get(h, 0) + 1
        slot_bytes[h] = bytes(tile)

    cands = json.load(open(CAND, encoding="utf-8"))["blocks"]
    rows, per_block = {}, []
    bad_header = small = decoded = 0
    for c in cands:
        off = int(c["offset"], 16)
        if rom[off] != 0x10:
            bad_header += 1
            continue
        if c["dlen"] < SCOPE_DLEN:
            small += 1
            continue
        out = lz77(rom, off)
        if out is None:
            continue
        decoded += 1
        tiles = []
        for k in range(0, len(out) - 31, 32):
            tile = out[k:k + 32]
            if len(set(tile)) <= 1:
                continue
            h = hashlib.sha256(tile).hexdigest()
            tiles.append(h)
            if h not in rows:
                rows[h] = {"uses": slots.get(h, 0), "blocks": set()}
            rows[h]["blocks"].add(c["offset"])
        matched = sum(1 for h in tiles if h in slots)
        if tiles and matched:
            per_block.append({"offset": c["offset"], "dlen": len(out), "refs": c.get("refs", 0),
                              "tiles": len(tiles), "matched": matched})

    joined = [h for h in rows if rows[h]["uses"] > 0]
    per_block.sort(key=lambda x: -x["matched"])
    with open(OUT_TSV, "w", encoding="utf-8", newline="\n") as f:
        f.write("# tile_sha256\tvram_slots\tblock_count\tfirst_block\n")
        for h in sorted(joined, key=lambda x: (-rows[x]["uses"], x)):
            r = rows[h]
            f.write("%s\t%d\t%d\t%s\n" % (h, r["uses"], len(r["blocks"]), sorted(r["blocks"])[0]))

    vram_only = sorted(set(slots) - set(rows))
    plain, absent = [], []
    for h in vram_only:
        pos = rom.find(slot_bytes[h])
        if pos >= 0:
            plain.append({"sha256": h, "rom_offset": "0x%X" % pos})
        else:
            absent.append(h)

    summary = {
        "rom_sha256": hashlib.sha256(rom).hexdigest(),
        "scope": "header_byte==0x10 strict AND dlen>=%d" % SCOPE_DLEN,
        "vram_source": "extract/frame900.json",
        "frame": d["frame"],
        "vram_sha256": vram_sha,
        "dump_self_sha256": d.get("self_sha256", ""),
        "vram_tile_slots": len(vram) // 32,
        "vram_unique_tiles": len(slots),
        "candidate_blocks": len(cands),
        "header_assert_failures": bad_header,
        "skipped_dlen_lt_32": small,
        "decoded_blocks": decoded,
        "tile_sha_unique": len(rows),
        "joined_tiles": len(joined),
        "vram_tiles_unmatched": len(vram_only),
        "unmatched_plain_in_rom": len(plain),
        "unmatched_absent_from_rom": len(absent),
        "plain_examples": plain[:5],
        "absent_sample": absent[:10],
        "joined_blocks": len(per_block),
        "caveat": "帧 900 标题画面单帧，单帧只算下界；uses=VRAM 内相同内容槽位数。",
        "top_blocks": per_block[:20],
    }
    json.dump(summary, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k not in ("top_blocks", "absent_sample", "plain_examples")}, ensure_ascii=False, indent=2))
    print("plain_examples:", plain[:3])
    print("top:", per_block[:3])


if __name__ == "__main__":
    main()
