# 图块资产表（严格口径，第一次合成）

- 生成器：`games/sacred-stones/tools/build-tile-assets.py`
- 候选集：`games/sacred-stones/extract/lz77-candidates.json`
- 严格 scope：**头字节 `== 0x10`（逐块断言）且 `dlen >= 32`** → 4,450 块（4 个 `dlen<32` 碎片按 scope 跳过）
- VRAM 快照：`.botharness/blocks-preview/vram-tiles.bin`（帧 900 标题画面，96 KiB / 3,072 槽）
- 产物：`extract/tile-assets.tsv`（1,477 行）、`extract/tile-assets-summary.json`

## 判据

1. 每块先断言 `rom[offset] == 0x10`，失败即计入 `header_assert_failures`（本次 **0**），不静默跳过
2. LZ77 解压，按 32 B 切 4bpp 图块，跳过纯色
3. 连接键 = **完整 sha256**（不是 sha1 前缀）
4. `vram_slots` = 该内容在 VRAM 的槽位数（**下界**）

## 结果

| 项 | 值 |
|---|---|
| 候选块 | 4,454 |
| 头字节断言失败 | **0** |
| scope 跳过（`dlen<32`） | 4 |
| 实际解压 | **4,450** |
| 解出唯一图块 | 238,373 |
| 与帧 900 VRAM 命中 | **1,477 / 1,611** |
| 未命中 VRAM 图块 | **134** |
| 有命中的块 | 342 |
| 单块最高 | `0xB5EFDC` 255/255（8 KiB 整屏组） |

## 134 个未命中的二分（已跑）

对每个未命中图块的 32 字节，在整份 16 MB ROM 里做字节搜索：

```
unmatched_plain_in_rom    : 0
unmatched_absent_from_rom : 134
```

**"明文存储漏枚举"假设被排除**：这 134 块不是 ROM 里某处的裸 32 字节。
剩下两种可能：**Huffman 压缩**（本口径不枚举）、**运行时拼装/代码生成**。区分方法见下一步（多帧"新增命中"曲线 + 区域分布）。

## 诚实边界

- 单帧只算**下界**；多帧按"帧 N → 新增 a / 累计 b / 仍未匹配 c"报，不报总数。
- `vram_slots` 不是游戏引用次数；真实引用数要解析 BG map（下一步地图合成）。
- 帧集合计划：标题 → 地图 → 对话 → 菜单 → 战斗，跑到新增为 0 或覆盖主要界面。

## 复现

```bash
python games/sacred-stones/tools/build-tile-assets.py
```
