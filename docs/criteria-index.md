# 判据索引（一条判据 → 哪个脚本 → 输入 → 当前期望值）

> 为什么有这张表：判据脚本分散在两个目录（`tools/` 是我的，`games/sacred-stones/` 是游戏实现与逆向的），
> 下一个人找工具时会找错地方，而 `grep` 找不到"我以为它在这"的东西。
> 这张表的第二个作用更要紧：**让"判据存在但没人跑"这件事变得可见** —— 状态列写"从未运行"的，
> 就是一条在需要它的那天一定会红的闸门。
>
> 更新规则：新增脚本必须在这里登记一行；跑过就改状态。最后更新 2026-10-30。

## 后台侧（`tools/`，我的）

| 判据 | 脚本 | 输入 | 当前期望值 | 状态 |
| --- | --- | --- | --- | --- |
| 上架闸门：三件齐全 + 白名单外文件 + 双口径摘要 + `manifestDigest`（blob vs worktree）+ `game.js ≤ 2 MB` | `tools/pkg-gate/check-package.mjs` | `--local-dir games/sacred-stones` 或 `--owner/--repo/--commit` | `distOnly = sha256:9243d0e4b9acdbc754a8393ee572a0bd54c5ce0a74273c3d31867ce3164cf553`、`manifest = sha256:813b0a47…`、PASS exit 0 | 2026-10-30 **首次运行**（此前从未跑过） |
| 确定性：`version` 与 `bundleDigest(仅 dist/)` 必须同变 | 同上（`--baseline tools/pkg-gate/baseline.json`，`--record-baseline` 记基线） | 基线 JSON + 当前包 | 与基线一致 → PASS；version 变而摘要不变 → FAIL exit 1；摘要变而 version 不变 → FAIL exit 1 | 2026-10-30 两条失败路径均已实测返回 1 |
| 清单四桶（shared / onlyA / onlyB / fieldMismatch） | `tools/lz77-diff/compare-sets.mjs` | 两份 TSV（`0x`+8 位小写，一行一个，`#` 头注） | 275 线：`shared 275 / onlyA 0 / onlyB 0 / fieldMismatch 0`，exit 0 | 已跑（对逆向 `extract/selfref-275.tsv`，两份真实导出互比） |
| 同上的自证 | 同上 `--self-test` | 无 | `self-test PASS (12 条)`，含"判定与退出码同源"两条 | 已跑 |

## 游戏包侧（`games/sacred-stones/`，游戏实现与逆向的）

| 判据 | 脚本 | 输入 | 当前期望值 | 状态 |
| --- | --- | --- | --- | --- |
| ROM 表头自检（checksum、title、code、存档介质） | `tools/fe8-scan.py` | ROM | `sha256 167ed57921c24f84…`、checksum `0xD7` PASS、`FIREEMBLEM8 / BE8J`、`SRAM 32 KiB (SRAM_F_V)` | 已跑（我代跑过并贴原始输出） |
| 存档介质标识串 | `tools/scan-backup-lib.mjs` | ROM | SRAM 32 KiB | 已跑 |
| 纯扫描 LZ77 召回上界（不是清单） | `tools/lz77-scan-recall.py` | ROM | `4,933` 块 | 已跑；**只用召回上界，不得当资产数** |
| 判据归因（先切总体再打标签，只追 `pass-all`） | `tools/lz77-gate-attr.py` | ROM | 清单 `4,454`、资产 scope（`dlen>=32`）`4,450` | 已跑 |
| 压缩比阈值标定 | `scripts/ratio-calibration.mjs` | ROM + 固定种子 | 洗牌噪声上界 `1.778`（种子 20261030，553 假阳性） | 已跑；**ratio 是诊断字段，不是闸门** |
| 清单逐行复算 + 头注断言计数 | `tools/verify-lz77-tsv.py` | `extract/lz77-pointers-4454.tsv` | 4,454 行全部通过；**该脚本一跑就发现过 flag 位序反** | 已跑 |
| 两份清单四桶 + 两桶畸形行 | `scripts/compare-block-lists.mjs` | 两份清单 | `4,454 ↔ 4,454` 全零、`malformed 0/0` | 已跑 |
| 自指针清单四桶 | `tools/compare-selfptr.py` | 两份自指针清单 | `shared 275 / onlyA 0 / onlyB 0` | 已跑（逆向侧） |
| VRAM 判据（用运行中游戏的 VRAM 当标准答案对图块） | `scripts/vram-oracle.mjs` | 帧转储 + ROM 块 | 帧 900：`0xA1317E` 的 8 个图块命中 **0/8** | 已跑 |
| 图块资产表（严格 `0x10` + `dlen>=32`） | `tools/build-tile-assets.py` | ROM、`extract/lz77-candidates.json`、`.botharness/blocks-preview/vram-tiles.bin` | `1,477` 命中 | 已跑（仅差 `category` 列） |
| 单层 BG oracle（隔离后逐像素比） | `scripts/layer-oracle.mjs` | 帧转储 + 合成图 | 帧 900：BG1 `skip-blank`（**无判决**）；BG2 78 色 = 11 个 bank 的并集（**已解释，正常**）；BG3 15 色 | 已跑；BG2 悬空已销 |
| BG 调色板 bank 硬约束 | `tools/render-frame.py`（summary.json） | 帧转储 | 每 bank 色数 ≤16 且 index ∈ [0,15]；帧 900 BG2：bank 0–10，每 bank 3–11 色 | 已跑 |
| BG1 bank15 反例帧 | `tools/render-frame.py`（扫其它帧） | 多帧转储 | 找到 bank15 非零的帧 → 出图作反例夹具；找不到记「仅帧 900 观察」 | **未跑（缺多帧转储）** |
| OBJ 单层 oracle | `scripts/obj-oracle.mjs` | 帧 3200（`DISPCNT=0x1300`） | 逐像素全等（修掉图块基址 `+0x10000` 与调色板偏移 `0x200` 两个 bug 之后） | 已跑 |
| 整屏 oracle（层间关系，不隔离） | `scripts/frame-oracle.mjs` | 帧转储 + 合成图 | 240×160 逐像素比；`bldcnt` 四字段已进 `summary.json` | 进行中（关键路径） |
| 帧比较（差异像素数与占比） | `scripts/compare-frame.mjs` | 实际图 + 期望图 | 输出差异像素数、占比、边界框 | 已跑 |
| 出包前硬自检（无 `import`/`export`、无大块 `data:`、≤2 MB） | `scripts/check-dist.mjs` | `dist/` | 全部通过才允许构建产物进 Issue | 已跑 |
| 与平台同口径的发布摘要 | `scripts/digest.mjs` | `dist/` | 与 `bundleDigest.ts` 逐字一致 | 已跑 |

## 两条"写了但没人跑过"的教训（保留在表里）

1. `tools/pkg-gate/check-package.mjs` 写了很久，**2026-10-30 才第一次运行**。
2. `tools/verify-lz77-tsv.py` 一跑就发现 flag 位序反 —— 一条从没运行过的判据，等于没有判据。

## 口径提醒（容易记错的两个数）

- **`9243d0e4…` 不是"和 14 MB 那份撞值"**（那是另一个游戏的产物，不可能同值）。真相是：
  它与 2026-10-30 01:2x 那个 110,600 B 的壳**逐字节相同**（`game.js` 104,793 + `index.html` 2,303 + `style.css` 3,504），
  即 **`dist/` 自 `c52192f` 以来一个字节没动，W 版前端还没落到 `dist`**。
  后果：把这个值抄进 Issue，等于**把 R 期模拟器壳登记成 W 版游戏**。
- `275` 是 `self-pointer hits, 4B-aligned window` —— 扫描窗口属性，不是类别规模。
