import json, struct, zlib, hashlib, os, base64

ROOT = r"C:\Users\salis\Desktop\dsh-game-boy\games\sacred-stones"
SRC = os.path.join(ROOT, "extract", "frame900.json")
OUT = os.path.join(ROOT, "extract", "frame900")
os.makedirs(OUT, exist_ok=True)

d = json.load(open(SRC, encoding="utf-8"))
vram = base64.b64decode(d["vram_base64"])
pal = base64.b64decode(d["palette_base64"])
assert hashlib.sha256(vram).hexdigest() == d["vram_sha256"], "vram hash mismatch"
assert hashlib.sha256(pal).hexdigest() == d["palette_sha256"], "palette hash mismatch"


def hx(v):
    return int(v, 16) if isinstance(v, str) else int(v)


dispcnt = hx(d["dispcnt"])
bgcnt = [hx(x) for x in d["bgcnt"]]
hofs, vofs = d["bghofs"], d["bgvofs"]
bldcnt, bldalpha = hx(d["bldcnt"]), hx(d["bldalpha"])
eva, evb = bldalpha & 0x1F, (bldalpha >> 8) & 0x1F
effect = (bldcnt >> 6) & 3
first_target = [n for n in range(4) if bldcnt & (1 << n)]
second_target = [n for n in range(4) if bldcnt & (1 << (8 + n))]
bd_in_second = bool(bldcnt & (1 << 13))
# machine-pinned BLDCNT parse (bit n = BGn 第一目标, bit 8+n = BGn 第二目标, bit13 = BD)
if bldcnt == 0x0C42:
    assert first_target == [1], first_target
    assert second_target == [2, 3], second_target
    assert bd_in_second is False
    assert (bldcnt >> 6) & 3 == 1  # alpha

COLORS = [struct.unpack_from("<H", pal, i * 2)[0] for i in range(512)]


def rgb555(c):
    r = (c & 0x1F) << 3
    g = ((c >> 5) & 0x1F) << 3
    b = ((c >> 10) & 0x1F) << 3
    return (r | (r >> 5), g | (g >> 5), b | (b >> 5))


def render_bg(n):
    cnt = bgcnt[n]
    bpp8 = bool(cnt & 0x80)
    char_base = ((cnt >> 2) & 3) * 0x4000
    scr_base = ((cnt >> 8) & 0x1F) * 0x800
    if (cnt >> 14) & 3:
        raise NotImplementedError("only 256x256 text BG supported")
    mat = [[None] * 240 for _ in range(160)]
    tiles = set()
    hist = {}
    for y in range(160):
        my = (y + vofs[n]) & 0xFF
        for x in range(240):
            mx = (x + hofs[n]) & 0xFF
            ent = struct.unpack_from("<H", vram, scr_base + (((my >> 3) * 32 + (mx >> 3)) << 1))[0]
            tile = ent & 0x3FF
            px, py = mx & 7, my & 7
            if (ent >> 10) & 1:
                px = 7 - px
            if (ent >> 11) & 1:
                py = 7 - py
            pbank = (ent >> 12) & 0xF
            if bpp8:
                ci = vram[char_base + tile * 64 + py * 8 + px]
                if ci == 0:
                    continue
            else:
                b = vram[char_base + tile * 32 + py * 4 + (px >> 1)]
                raw = (b >> 4) if (px & 1) else (b & 0xF)
                if raw == 0:  # 4bpp: index 0 is transparent in EVERY bank
                    continue
                ci = raw + pbank * 16
            tiles.add((tile, pbank))
            hist[(pbank, raw)] = hist.get((pbank, raw), 0) + 1
            mat[y][x] = COLORS[ci]
    return mat, sorted(tiles), hist


def png_rgb(path, rows):
    h, w = len(rows), len(rows[0])
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)

    def chunk(t, data):
        return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


mats, tilesets, hists = {}, {}, {}
for n in range(4):
    if dispcnt & (1 << (8 + n)) and bgcnt[n]:
        mats[n], tilesets[n], hists[n] = render_bg(n)
    else:
        mats[n], tilesets[n], hists[n] = None, None, None

prio = {n: bgcnt[n] & 3 for n in range(4) if mats[n] is not None}
order = sorted(prio, key=lambda n: prio[n])

roles = {}
for n in mats:
    r = []
    if n in first_target:
        r.append("first")
    if n in second_target:
        r.append("second")
    roles[n] = "+".join(r) if r else "none"

witness = {}
for n in mats:
    if mats[n] is None:
        witness[str(n)] = {"state": "not-drawn", "blend_role": roles.get(n, "none")}
        continue
    mat = mats[n]
    colors = {}
    opaque = 0
    for row in mat:
        for px in row:
            if px is not None:
                opaque += 1
                colors[px] = colors.get(px, 0) + 1
    hist_items = list((hists[n] or {}).items())
    top = sorted(colors.items(), key=lambda kv: -kv[1])[:3]
    banks = sorted({pb for _t, pb in tilesets[n]})
    per_bank = {}
    for c, k in colors.items():
        b = (c & 0x1F)  # placeholder, replaced below
    bank_counts = {}
    for row in mat:
        for px in row:
            if px is not None:
                bank_counts[px] = bank_counts.get(px, 0) + 1
    witness[str(n)] = {
        "state": "on",
        "blend_role": roles.get(n, "none"),
        "pixels_opaque": opaque,
        "distinct_colors": len(colors),
        "palette_banks": banks,
        "distinct_palette_banks": len(banks),
        "colors_per_bank": {pb: len({COLORS[pb * 16 + i] for (p2, i) in (hists[n] or {}) if p2 == pb}) for pb in banks},
        "max_colors_per_bank": max((len({COLORS[pb * 16 + i] for (p2, i) in (hists[n] or {}) if p2 == pb}) for pb in banks), default=0),
        "top_colors": [{"color": "%04X" % c, "count": k} for c, k in top],
        "tiles_used": len(tilesets[n]),
        "prio": prio[n],
        "index_histogram": [
            {"bank": pb, "index": idx, "pixels": k, "palette_raw": "%04X" % COLORS[pb * 16 + idx]}
            for (pb, idx), k in sorted(hist_items, key=lambda kv: -kv[1])[:16]
        ],
    }

comp = [[None] * 240 for _ in range(160)]
bd = rgb555(COLORS[0])
for y in range(160):
    for x in range(240):
        stack = [(n, mats[n][y][x]) for n in order if mats[n][y][x] is not None]
        if not stack:
            comp[y][x] = bd
            continue
        top_n, top_c = stack[0]
        if effect == 1 and top_n in first_target:
            under = next((c for nn, c in stack[1:] if nn in second_target), None)
            if under is not None:
                out = 0
                for sh in (0, 5, 10):
                    v = (((top_c >> sh) & 0x1F) * eva + ((under >> sh) & 0x1F) * evb) >> 4
                    out |= (31 if v > 31 else v) << sh
                top_c = out
        comp[y][x] = top_c

# A/B: composite without the first-target layers, against the real one (15-bit domain)
comp_no_first = [[None] * 240 for _ in range(160)]
for y in range(160):
    for x in range(240):
        stack = [(n, mats[n][y][x]) for n in order if mats[n][y][x] is not None and n not in first_target]
        if not stack:
            comp_no_first[y][x] = rgb555(COLORS[0])
        else:
            comp_no_first[y][x] = stack[0][1]
ab_diff = ab_half = ab_nounder = 0
for y in range(160):
    for x in range(240):
        wa = [[None] * 240 for _ in range(160)] if False else None
for y in range(160):
    for x in range(240):
        a5 = comp[y][x]
        b5 = comp_no_first[y][x]
        if a5 != b5:
            ab_diff += 1
            if all((((a5 >> sh) & 0x1F) == (((b5 >> sh) & 0x1F) >> 1)) for sh in (0, 5, 10)):
                ab_half += 1

for n in order:
    rows = [[rgb555(px) if px is not None else (255, 0, 255) for px in row] for row in mats[n]]
    png_rgb(os.path.join(OUT, "bg%d.png" % n), rows)
rowsp = [[rgb555(px) for px in row] for row in comp]
png_rgb(os.path.join(OUT, "composite.png"), rowsp)
mask_rows = [[(255, 255, 255) if mats[1][y][x] is not None else (0, 0, 0) for x in range(240)] for y in range(160)]
mask_path = os.path.join(OUT, "bg1-mask.png")
png_rgb(mask_path, mask_rows)
mask_sha = hashlib.sha256(open(mask_path, "rb").read()).hexdigest()
def under_color(y, x):
    for n in order:
        if n == 1 or n not in second_target:
            continue
        if mats[n][y][x] is not None:
            return mats[n][y][x]
    return None

# 独立路径 A：从"下方颜色直方图"数 0x0000 的像素集合
under_black_set = set()
for y in range(160):
    for x in range(240):
        if mats[1][y][x] is not None and under_color(y, x) == 0:
            under_black_set.add((y, x))
under_black = len(under_black_set)
# 独立路径 B：逐像素比较"混合后输出"与"不混合输出"的值，相等者入集
same_result_set = set()
BLIND_ASSUMPTION = "reference-side: frame900.json (sha256 c1fdc400..., vram 73025eda...) registers = frame 900 (dump taken AFTER last runFrame, per game impl 0169d4f); blind = pixels where composite-with-first-target == composite-without-first-target in 15-bit domain"
for y in range(160):
    for x in range(240):
        if mats[1][y][x] is not None and comp[y][x] == comp_no_first[y][x]:
            same_result_set.add((y, x))
assert under_black_set == same_result_set, (len(under_black_set), len(same_result_set))
assert under_black == witness["1"]["pixels_opaque"] - ab_diff, (under_black, witness["1"]["pixels_opaque"], ab_diff)
blind_rows = [[(255, 255, 255) if (mats[1][y][x] is not None and under_color(y, x) == 0) else (0, 0, 0) for x in range(240)] for y in range(160)]
blind_path = os.path.join(OUT, "bg1-blindzone.png")
png_rgb(blind_path, blind_rows)
blind_sha = hashlib.sha256(open(blind_path, "rb").read()).hexdigest()

summ = {
    "frame": d["frame"],
    "source": "extract/frame900.json",
    "source_vram_sha256": d["vram_sha256"],
    "source_palette_sha256": d["palette_sha256"],
    "dispcnt": "0x%04X" % dispcnt,
    "bldcnt_raw": "0x%04X" % bldcnt,
    "firstTarget": first_target,
    "blendMode": {0: "none", 1: "alpha", 2: "brightness_up", 3: "brightness_down"}[effect],
    "secondTarget": second_target,
    "bd": bd_in_second,
    "bldcnt_parse": {
        "raw": "0x%04X" % bldcnt,
        "mode": {0: "none", 1: "alpha", 2: "brightness_up", 3: "brightness_down"}[(bldcnt >> 6) & 3],
        "firstTarget": ["BG%d" % n for n in first_target],
        "secondTarget": ["BG%d" % n for n in second_target],
        "backdrop": bd_in_second,
    },
    "eva": eva,
    "evb": evb,
    "hofs": hofs,
    "vofs": vofs,
    "layers": witness,
    "blind_1": {"mask_convention": {"width": 240, "height": 160, "row_major": True, "bit_source": "same-result", "msb_first": True, "pad": "row-pad-to-byte"}, "file": "bg1-blindzone.png", "pixels": sum(1 for r in blind_rows for v in r if v == (255, 255, 255)), "sha256": blind_sha, "definition": "白=混合输出与不混合输出同值的像素（不可判区，由参照侧独立算出）", "assumption": BLIND_ASSUMPTION, "computedBy": "reference-side", "source_frame900_sha256": hashlib.sha256(open(os.path.join(os.path.dirname(OUT), "frame900.json"), "rb").read()).hexdigest()},
    "under_black_pixels": under_black,
    "verification_status": "recomputed against new dump (registers = frame 900, dump after last runFrame); source frame900.json sha256 in blind_1.source_frame900_sha256",
    "mask_1": {"mask_convention": {"width": 240, "height": 160, "row_major": True, "bit_source": "bg1-opaque", "msb_first": True, "pad": "row-pad-to-byte"}, "file": "bg1-mask.png", "pixels": witness["1"]["pixels_opaque"], "sha256": mask_sha, "definition": "白色=BG1 索引!=0（硬件意义下不透明），黑色=透明；用于与 oracle 的混合掩码对撞"},
    "ab_test": {"description": "composite with first-target layer vs without it; half check in 15-bit domain: out_with == out_without >> 1 per 5-bit channel", "diff_pixels": ab_diff, "exact_half": ab_half, "layer1_opaque": witness["1"]["pixels_opaque"], "blended_pixels": ab_diff, "same_result_pixels": witness["1"]["pixels_opaque"] - ab_diff, "same_result_reason": "下方首个第二目标颜色为 0x0000，混合结果与不混合同值（不等于“无第二目标”）"},
 "bg1_index_histogram": {("%d" % r): {"pixels": k, "palette_raw": "%04X" % COLORS[(15 << 4) + r]} for (b, r), k in sorted(h1hist.items())} if False else None,
 "composite_rgb_sha256": hashlib.sha256(bytes(c for row in rowsp for px in row for c in px)).hexdigest(),
    "png_sha256": {},
}
for n in order:
    summ["png_sha256"]["bg%d" % n] = hashlib.sha256(open(os.path.join(OUT, "bg%d.png" % n), "rb").read()).hexdigest()
summ["png_sha256"]["composite"] = hashlib.sha256(open(os.path.join(OUT, "composite.png"), "rb").read()).hexdigest()
json.dump(summ, open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(json.dumps(summ, ensure_ascii=False, indent=1))
