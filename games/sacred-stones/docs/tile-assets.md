# 图块资产表（第一次合成）

- 生成器：`games/sacred-stones/tools/build-tile-assets.py`（读 ROM + 候选集 + VRAM 单帧快照）
- 候选集：`games/sacred-stones/extract/lz77-candidates.json`（严格 `0x10` 口径，4,454 块）
- VRAM 快照：`.botharness/blocks-preview/vram-tiles.bin`（帧 900 标题画面，96 KiB）
- 产物：`extract/tile-assets.tsv`（**1,477 行**：命中图块 × 出现次数）、`extract/tile-assets-summary.json`（统计与 top 块）

## 判据

1. 候选块按 LZ77 解压，按 32 B 切 4bpp 图块，跳过纯色块；
2. 对每个图块取**完整 sha256**（不是 sha1 前缀）做连接键；
3. VRAM 槽位按 32 B 切、跳过纯色，同内容槽位数记为 `vram_slots`（**下界**：只证明这一帧里重复了几份）；
4. 连接即得：命中图块 1,477 / VRAM 唯一图块 1,611 / 有命中的候选块 342。

## 结果

| 项 | 值 |
|---|---|
| 候选块 | 4,454（解压失败 0） |
| 候选解出的唯一图块 | 238,373 |
| 与帧 900 VRAM 命中 | **1,477** |
| VRAM 中未命中 | **134** |
| 有至少一个图块命中的块 | 342 |
| 单块命中最多 | `0xB5EFDC`：255/255 图块全中（8 KiB 整屏图块组） |

top 块集中在 `0xB5xxxx–0xB8xxxx`，dlen 多 8,192 B——标题画面整屏图块组的典型形态。

## 诚实边界

- **单帧**：只覆盖帧 900 加载进 VRAM 的图块；未命中不等于不存在（可能别的帧加载、运行时拼装、或本镜像补丁改动）。
- **VRAM 中 134 块未在候选集里找到**：三种嫌疑——(a) 指针未 4 字节对齐（已知 `0xA1317E` 一例）；(b) Huffman 压缩（本口径不报数）；(c) 运行时拼装/写入。这 134 块是下一轮排查名单（`summary.json.unmatched_sample` 给了前 10 个 sha256）。
- `vram_slots` 是**重复槽位数**，不是"游戏引用次数"；真实引用数要解析 BG map（下一步地图合成时一起做）。

## 复现

```bash
python games/sacred-stones/tools/build-tile-assets.py
```

（脚本内路径以仓库根为基准；VRAM 快照由 `scripts/vram-oracle.mjs` 生成。）
