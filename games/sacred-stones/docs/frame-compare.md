# 帧比对口径（frame compare）

## `self_sha256` 定义（写死，唯一解释）

`self_sha256 = sha256(文件字节，且把 `self_sha256` 字段的值替换成 64 个 ASCII '0')`

- 不是"排除该字段再算"（那会改变字节数），也不是"算完再填"（不收敛）。
- 校验方式：读文件 → 用正则把 `"self_sha256": "<64 hex>"` 的值替换成 64 个 `0` → 对整段字节做 sha256 → 与字段值比。
- 参考实现见 `tools/frame900-selfcheck.py`（若缺失，按上面三行实现即可）。

## 帧 900 合成（`extract/frame900/summary.json`）

- 输入：`extract/frame900.json`（同帧：DISPCNT / BGxCNT / BGxHOFS / BGxVOFS / BLDCNT / BLDALPHA / BLDY / VRAM / PALETTE，均为原始字节与寄存器值）。
- `bldcnt 0x0c42` → `firstTarget=[1]`、`mode=alpha`、`secondTarget=[2,3]`、`bd=false`、`eva=evb=8`（summary 里存字段，不存原始字）。
- 层：BG0 not-drawn（DISPCNT bit8=0）；BG1 first（274 tiles，14,564 不透明像素，1 色）；BG2 second（133 tiles，6,241 像素，78 色，11 个 palette bank）；BG3 second（255 tiles，38,400 像素，15 色，1 个 bank）。
- 混合在 **15-bit 域**做：`v = (A5*EVA + B5*EVB) >> 4`，逐通道，结果仍为 15-bit；PNG 再用 `v<<3|v>>2` 展开到 8 位。8 位域混合与 5 位域混合相差 1 个 5-bit 级，不能混用。

## A/B 判据（BG1 是否黑幕）

预测：BG1 色值全 0 且 EVA=EVB=8 ⇒ 被 BG1 覆盖且下方有 second-target 的像素，`out_with == out_without >> 1`（逐 5-bit 通道，floor）。

实测（`ab_test` 字段）：

```
diff_pixels = 13515
exact_half  = 13515   # 100% 命中预测
```

- 差为 13,515 而非 14,564：剩余 1,049 个 BG1 不透明像素下方 BG2/BG3 均透明，有无 BG1 都是背景黑，不产生差异、也不发生混合。
- 结论：BG1 在这一帧就是一层黑色遮罩，参与 alpha 混合；跳过它会让 14,564 个像素偏亮。

## BG1 的索引直方图（决定"黑"的来源）

`summary.json` → `layers.1.index_histogram`：15 个不同索引，全部落在 **bank 15**，且 `palette_raw` 全为 `0000`（前几个：idx13=1,685、idx2=1,604、idx11=1,500、idx8=1,338、idx12=1,308…）。

⇒ 不是"所有像素同一个索引"，而是 **bank 15 这一帧没被写入**（15 个索引映射到 15 个空槽）。这解释了两件事：

1. 视觉上是 1 色（全黑）；
2. 几何是真的（274 个图块被引用），**别的帧 bank 15 一旦被加载，BG1 会显出内容** —— 后续帧不能沿用"BG1 恒黑"的假设。

## BG2 的 78 色

4bpp 单 bank 上限 16 色，但 **map entry 的 bit12–15 逐图块选择 palette bank**：BG2 用了 banks 0–10（11 个），每 bank 最多 11 色，合计 78 色，属正常，不是 8bpp 误读、也不是字节当索引。

## 已知未覆盖（不得写成"全覆盖"）

- DARKEN 15-bit 域 vs @gba-kit 8-bit 域（约 13% 像素受影响）；
- `expand5` 展开方式（`v<<3` vs `v<<3|v>>2`）；
- Window / Mosaic / 仿射层；
- 模拟器内核 vs 真机。

## BG 寻址与掩码（帧 900 实测）

- 文本 BG 的屏幕尺寸取 `BGxCNT` bits14-15：`0`=256×256（32×32 tiles），`1`=512×512（64×64，按 `tileX>=32 / tileY>=32` 分四象限，各象限起始 0x800），`2`=256×512，`3`=512×256。
- 帧 900 `BG1 CNT=0x1C01` ⇒ **size=0，256×256，无象限问题**；坐标为 `tileX=((px+hofs)&0xFF)>>3`、`tileY=((py+vofs)&0xFF)>>3`（先 `&0xFF` 再 `>>3`）。
- 透明由 **像素索引==0** 决定，不是调色板值：BG1 的 bank 15 全 `0000` 是**不透明黑**。
- 不透明掩码已导出：`extract/frame900/bg1-mask.png`（白=索引!=0，14,564 px，`sha256 e05ab9517808f6695a899f143d8726790115c6c43ae17e7f233b7ef3b380c114`），供与 oracle 的掩码逐像素对撞。
- 混合分解：`14,564 = 13,515（混合）+ 1,049（下方无第二目标，不混合，BG1 原色直出）`；`0x0C42` 的 BD(bit13) 未置，第二目标为 BG2+BG3。

## `self_sha256` 的边界

`self_sha256` 只能发现"字节被改过"，发现不了"被故意改过"（改完顺手重算即可）；它是自检，不是校验和基线，不得用于"证明某份产物未被改动"的句子。
