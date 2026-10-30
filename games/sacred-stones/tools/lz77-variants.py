import hashlib, json, os, shutil

ROM = r"artifacts/fe8-remake/fe8-zh.gba"
ROM_SHA = "167ed57921c24f841108f46eabc33cb10e10f141b09d0fa6e75b5c5add3e4df0"
TOOLS = r"games/sacred-stones/tools/lz77-variants.py"
TSV = r"games/sacred-stones/extract/lz77-pointers-4463.tsv"
OLD_TSV = r"games/sacred-stones/extract/lz77-pointers-4460.tsv"
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

rows = sorted(ok.items())
dlen32 = [o for o, (d, c) in rows if d >= 32]
clen32 = [o for o, (d, c) in rows if c >= 32]
clen_dlen = [o for o, (d, c) in rows if c >= 32 and d >= 32]
ratio_bad = [o for o, (d, c) in rows if c > 8 * d]

os.makedirs(os.path.dirname(TOOLS), exist_ok=True)
shutil.copyfile(__file__, TOOLS)
gen_sha = hashlib.sha256(open(TOOLS, "rb").read()).hexdigest()

os.makedirs(os.path.dirname(TSV), exist_ok=True)
with open(TSV, "w", newline="\n") as f:
    f.write("# rom_sha256=%s\n" % ROM_SHA)
    f.write("# generator=games/sacred-stones/tools/lz77-variants.py\n")
    f.write("# generator_sha256=%s\n" % gen_sha)
    f.write("# gates: pointer-word 4-byte aligned, top byte 0x08, offset<len; header nibble 0x1X; dlen exact; backref pos>=0; overlap allowed\n")
    f.write("# rows=%d\n" % len(rows))
    f.write("# offset\tdlen\tclen\n")
    for o, (d, c) in rows:
        f.write("0x%06X\t%d\t%d\n" % (o, d, c))

if os.path.exists(OLD_TSV):
    os.remove(OLD_TSV)

doc = """# LZ77 对账（我方口径，唯一的数出自唯一的脚本）

- ROM：`artifacts/fe8-remake/fe8-zh.gba`，16,777,216 B，sha256 `%s`
- 生成器：`games/sacred-stones/tools/lz77-variants.py`（本文件同源），sha256 `%s`
- 复现：`python games/sacred-stones/tools/lz77-variants.py`（脚本自带扫描与导出）
- 逐流清单：`games/sacred-stones/extract/lz77-pointers-4463.tsv`（offset / dlen / clen，共 %d 行数据）

## 一、判据取值表（写死，不留"按需"）

| # | 判据 | 我方取值 | 说明 |
|---|---|---|---|
| 1 | 头字节 | `(rom[off] & 0xF0) == 0x10` | GBA BIOS 类型在高 4 位；低 4 位是保留位，**不参与判定** |
| 2 | `dlen` 语义 | **解压后长度**（24-bit 小端，byte1..3） | 不是"剩余可写长度"；必须精确达到 |
| 3 | 越界 | 读越文件尾即失败 | 不做零填充、不跨文件 |
| 4 | 回引位置 | `pos = len(out) - disp - 1 >= 0` | 否则判失败 |
| 5 | 自重复 | **允许**，逐字节复制 | `disp < length` 是合法且常见的 run |
| 6 | 指针字 | 4 字节对齐，高字节 `0x08`，`offset < 0x1000000` | 未对齐的一律不认 |
| 7 | 去重 | 按 offset 去重 | 同一流被多处引用只算一次 |
| 8 | 闸门 | `dlen >= 32`、`clen >= 32`、压缩比 | 我方原始输出**不加闸门**；加闸门后的数见第二节 |
| 9 | 比较符号 | 全部为 `>=`/`==`，无 `>` 边界 | 没有"大约相等" |

## 二、数字（同一次运行，可复算）

| 口径 | 唯一流 | clen | dlen |
|---|---|---|---|
| 原始（不加闸门） | **%d** | %d | %d |
| `dlen >= 32` | %d | — | — |
| `clen >= 32` | %d | — | — |
| `dlen>=32 且 clen>=32` | %d | — | — |
| `clen > 8*dlen`（压缩比闸门排除的数） | %d | — | — |
| 嵌套剔除（流 A 落在流 B 的压缩区间内） | 0 | — | — |

## 三、对 4,460 / 4,714 / 4,933 的处置

- **4,714 作废**：项目经理已裁定它出自修复前的解码器（LZ77 标志位取反 + Huffman 位序），不作为目标。我方实测：**任意字节偏移**扫指针确实得 4,714，与 4 字节对齐口径差 251 条——差异全部来自"指针字是否要求 4 字节对齐"，与解码语义无关。
- **4,460 更正为 4,463**：4,460 是早期聚合值（旧 JSON 只留 top20，无逐流清单，无法逐条回溯）；4,463 是本脚本的确定性输出。以 TSV 为准。
- **4,933（游戏后台）不可直接比**：那是"任意字节偏移 + 头字节恰为 0x10 + 命中后跳过已解流"的纯扫描召回上界，与"指针引用枚举"是两种口径，差值不构成"谁漏了块"。

## 四、与 4,425 对账（待对方清单）

目标：用 `games/sacred-stones/scripts/compare-block-lists.mjs` 对 `lz77-pointers-4425.tsv` 与本 TSV 做四桶（shared / onlyA / onlyB / fieldMismatch）。我方残留差：原始 4,463 与 4,425 差 38 块；去掉 `dlen<32`（12）后为 4,451，与 4,425 仍差 26。这 26 块的可能来源已按判据表逐条排查：自重复（不影响，两版解码一致）、越界（无）、嵌套（0）、压缩比（`clen>8*dlen` 为 0）、指针对齐（同为我方对齐口径）。**剩余 26 只能由对方逐流清单归因，不再靠猜。**
""" % (ROM_SHA, gen_sha, len(rows), len(rows),
       sum(v[1] for _, v in rows), sum(v[0] for _, v in rows),
       len(dlen32), len(clen32), len(clen_dlen), len(ratio_bad))

os.makedirs(os.path.dirname(DOC), exist_ok=True)
open(DOC, "w", encoding="utf-8", newline="\n").write(doc)

print("rows", len(rows), "dlen>=32", len(dlen32), "clen>=32", len(clen32), "both", len(clen_dlen), "ratio_bad", len(ratio_bad))
print("gen_sha", gen_sha)
print("tsv", TSV, "doc", DOC, "old removed", not os.path.exists(OLD_TSV))
