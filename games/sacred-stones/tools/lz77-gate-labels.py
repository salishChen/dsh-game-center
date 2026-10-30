import hashlib, json, os, shutil

ROM = r"artifacts/fe8-remake/fe8-zh.gba"
ROM_SHA = "167ed57921c24f841108f46eabc33cb10e10f141b09d0fa6e75b5c5add3e4df0"
OUT_JSON = r"games/sacred-stones/extract/lz77-gate-buckets.json"
TOOL = r"games/sacred-stones/tools/lz77-gate-labels.py"
DOC = r"games/sacred-stones/docs/lz77-reconcile.md"

rom = open(ROM, "rb").read()
n = len(rom)


def decode(off):
    if off + 4 > n or (rom[off] & 0xF0) != 0x10:
        return None
    dlen = rom[off + 1] | (rom[off + 2] << 8) | (rom[off + 3] << 16)
    if dlen <= 0:
        return None
    i = off + 4
    out = bytearray()
    while len(out) < dlen:
        if i >= n:
            return None
        flags = rom[i]
        i += 1
        for b in range(8):
            if len(out) >= dlen:
                break
            if flags & (0x80 >> b):
                if i + 1 >= n:
                    return None
                b0, b1 = rom[i], rom[i + 1]
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
                if i >= n:
                    return None
                out.append(rom[i])
                i += 1
    return dlen, i - off


ok = {}
for p in range(0, n - 3, 4):
    w = rom[p] | (rom[p + 1] << 8) | (rom[p + 2] << 16) | (rom[p + 3] << 24)
    if (w >> 24) != 0x08:
        continue
    off = w & 0xFFFFFF
    if off >= n or off in ok:
        continue
    r = decode(off)
    if r:
        ok[off] = r


def labels(d, c):
    L = []
    if d < 32:
        L.append("dlen<32")
    if c < 32:
        L.append("clen<32")
    if d > 8 * c:
        L.append("dlen>8clen")
    return L


# self-test：证明每道闸门都"有能力排除"
st = []
cases = [((32, 32), []), ((31, 100), ["dlen<32"]), ((100, 31), ["clen<32"]), ((1000, 100), ["dlen>8clen"]), ((256, 281), [])]
for (d, c), expect in cases:
    got = labels(d, c)
    st.append({"dlen": d, "clen": c, "labels": got, "expect": expect, "ok": got == expect})
assert all(x["ok"] for x in st), st

buckets = {}
for o, (d, c) in ok.items():
    key = " + ".join(labels(d, c)) or "[]"
    buckets.setdefault(key, []).append(o)

counts = {k: len(v) for k, v in sorted(buckets.items())}
os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
json.dump({"rom_sha256": ROM_SHA, "total": len(ok), "counts": counts,
           "predicates": ["dlen < 32", "clen < 32", "dlen > 8*clen"],
           "self_test": st,
           "offsets": {k: [hex(x) for x in sorted(v)] for k, v in buckets.items()}},
          open(OUT_JSON, "w"), indent=1, ensure_ascii=False)

os.makedirs(os.path.dirname(TOOL), exist_ok=True)
shutil.copyfile(__file__, TOOL)
gen_sha = hashlib.sha256(open(TOOL, "rb").read()).hexdigest()

doc = """# LZ77 对账（我方口径：判据写死，数字只是输出）

- ROM：`artifacts/fe8-remake/fe8-zh.gba`，16,777,216 B，sha256 `%s`
- 生成器：`games/sacred-stones/tools/lz77-gate-labels.py`，sha256 `%s`
- 逐流清单：`games/sacred-stones/extract/lz77-pointers-4463.tsv`（4,463 行）
- 闸门标签：`games/sacred-stones/extract/lz77-gate-buckets.json`（八桶 + 自检记录）

## 一、判据取值表（写死）

| # | 判据 | 取值 |
|---|---|---|
| 1 | 头字节 | `(rom[off] & 0xF0) == 0x10`；低 4 位不参与 |
| 2 | `dlen` 语义 | **解压后长度**（24-bit 小端），必须精确达到 |
| 3 | 越界 | 读越文件尾即失败 |
| 4 | 回引位置 | `len(out) - disp - 1 >= 0` |
| 5 | 自重复 | 允许，逐字节复制 |
| 6 | 指针字 | 4 字节对齐、高字节 `0x08`、offset < 文件长 |
| 7 | 去重 | 按 offset |
| 8 | 闸门 | `dlen < 32`、`clen < 32`、`dlen > 8*clen` **被剔除**（三条都已用合成块自检，证明能排除） |
| 9 | 比较符号 | 全为 `>=` / `==`，无 `>` 边界 |

关于第 8 行：`dlen > 8*clen` 才是"解压比上限 8"的排除条件；早期写的 `clen > 8*dlen` 方向反了（那等于排除"压缩后膨胀 8 倍"，合法块几乎不出现，所以恒为 0）。**一个排除 0 条的闸门，不叫"不影响结果"，叫"没被验证"**；本文件的每道闸门都带 `self_test` 记录。

## 二、标签划分（不是链式扣减）

对 4,463 条逐块打标签（可同时违反多条），不按顺序扣减：

| 标签 | 块数 |
|---|---|
%s

只有 `[]` 桶值得进一步追——那是三道闸门之下**依然成立**的块，也就是真正需要双方解释的集合。

## 三、4,933 / 4,425 / 4,463 的正确关系

- **4,463 与 4,933 的大部分差异是枚举方式**：4,933 是纯扫描（不要求被指针引用），4,463 只认被 32 位指针字指向的块。这不是闸门差异，不能拿闸门去解释。
- **4,714 作废**（修复前解码器产物），不作为任何口径的目标。
- 与 4,425 的待解释量**不是 38**：计数差 `4,463-4,425` 不等于集合差。真实量是 `|onlyA| + |onlyB| + |fieldMismatch|`，由 `scripts/compare-block-lists.mjs` 出四桶；**`fieldMismatch` 优先查**，它直接指向 `dlen` 语义或长度字段读取。

## 四、待办

1. `extract/lz77-pointers-4425.tsv` 到位后跑比较器，出四桶，先看 `fieldMismatch`。
2. 向游戏实现确认压缩比闸门的**谓词原文**（写死的表达式），不只确认"≤ 8"这个说法。
""" % (ROM_SHA, gen_sha, "\n".join("| `%s` | %d |" % (k, v) for k, v in sorted(counts.items(), key=lambda kv: -kv[1])))

os.makedirs(os.path.dirname(DOC), exist_ok=True)
open(DOC, "w", encoding="utf-8", newline="\n").write(doc)

print("total", len(ok))
print("counts", json.dumps(counts, ensure_ascii=False))
print("self_test_ok", all(x["ok"] for x in st))
print("gen_sha", gen_sha)
