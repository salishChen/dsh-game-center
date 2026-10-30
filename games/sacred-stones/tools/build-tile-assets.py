# 图块资产表：候选 LZ77 块 ⋈ 帧 900 VRAM 图块（完整 sha256 连接）
# 输入：ROM、extract/lz77-candidates.json、.botharness/blocks-preview/vram-tiles.bin
# 输出：extract/tile-assets.tsv、extract/tile-assets-summary.json
import hashlib, json, os, sys

ROOT = r"C:\Users\salis\Desktop\dsh-game-boy"
ROM = os.path.join(ROOT, "artifacts/fe8-remake/fe8-zh.gba")
CAND = os.path.join(ROOT, "games/sacred-stones/extract/lz77-candidates.json")
VRAM = os.path.join(ROOT, ".botharness/blocks-preview/vram-tiles.bin")
OUT_TSV = os.path.join(ROOT, "games/sacred-stones/extract/tile-assets.tsv")
OUT_JSON = os.path.join(ROOT, "games/sacred-stones/extract/tile-assets-summary.json")


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
    vram = open(VRAM, "rb").read()
    # VRAM 图块槽：按 32B 切，跳过纯色；同内容计数=该内容在 VRAM 的槽位数
    slots = {}
    for t in range(0, len(vram) - 31, 32):
        tile = vram[t:t + 32]
        if len(set(tile)) <= 1:
            continue
        h = hashlib.sha256(tile).hexdigest()
        slots[h] = slots.get(h, 0) + 1

    cands = json.load(open(CAND, encoding="utf-8"))["blocks"]
    rows = {}          # tile_sha256 -> dict(uses, blocks=set)
    per_block = []
    bad = 0
    for c in cands:
        off = int(c["offset"], 16)
        out = lz77(rom, off)
        if out is None:
            bad += 1
            continue
        tiles = []
        for k in range(0, len(out) - 31, 32):
            tile = out[k:k + 32]
            if len(set(tile)) <= 1:
                continue
            h = hashlib.sha256(tile).hexdigest()
            tiles.append(h)
            if h not in rows:
                rows[h] = {"uses": slots.get(h, 0), "blocks": set(), "refs": c.get("refs", 0)}
            rows[h]["blocks"].add(c["offset"])
        matched = sum(1 for h in tiles if h in slots)
        if tiles and matched:
            per_block.append({"offset": c["offset"], "dlen": len(out), "refs": c.get("refs", 0),
                              "tiles": len(tiles), "matched": matched})

    per_block.sort(key=lambda x: -x["matched"])
    joined = [h for h in rows if rows[h]["uses"] > 0]
    with open(OUT_TSV, "w", encoding="utf-8", newline="\n") as f:
        f.write("# tile_sha256\tvram_slots\tblock_count\tfirst_block\n")
        for h in sorted(joined, key=lambda x: (-rows[x]["uses"], x)):
            r = rows[h]
            f.write("%s\t%d\t%d\t%s\n" % (h, r["uses"], len(r["blocks"]), sorted(r["blocks"])[0]))

    matched_tiles = len(joined)
    vram_only = sorted(set(slots) - set(rows))
    summary = {
        "rom_sha256": hashlib.sha256(rom).hexdigest(),
        "vram_bin": os.path.relpath(VRAM, ROOT).replace(os.sep, "/"),
        "vram_tile_slots": len(vram) // 32,
        "vram_unique_tiles": len(slots),
        "candidate_blocks": len(cands),
        "decoded_blocks": len(cands) - bad,
        "decode_failures": bad,
        "tile_sha_unique": len(rows),
        "joined_tiles": matched_tiles,
        "vram_tiles_unmatched": len(vram_only),
        "unmatched_sample": vram_only[:10],
        "joined_blocks": len(per_block),
        "caveat": "帧 900 标题画面单帧；未命中不等于不存在（可能在别的帧加载、运行时拼装或被补丁改过）。uses=VRAM 内相同内容槽位数（下界）。",
        "top_blocks": per_block[:20],
    }
    json.dump(summary, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k != "top_blocks"}, ensure_ascii=False, indent=2))
    print("top:", per_block[:5])


if __name__ == "__main__":
    main()
