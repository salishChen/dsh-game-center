# 判据索引（判据 → 脚本 → 输入 → 期望值 → 最近一次运行）

> 为什么有这张表：判据脚本分散在两个目录（`tools/` 是我的，`games/sacred-stones/{tools,scripts}/` 是游戏实现与逆向的），
> 下一个人找工具时会找错地方，而 `grep` 找不到"我以为它在这"的东西。
> 第二个作用更要紧：**让"判据存在但没人跑"这件事有地方显示出来** —— 「最近一次运行」空着，就是没跑过。
>
> 完整性由 `tools/criteria-index/check-index.mjs` 自证：任何脚本没进表、也不在排除清单里，它就红。
> 最后更新 2026-10-30。

## 后台侧（`tools/`，我的）

| 判据 | 脚本 | 输入 | 期望值 | 最近一次运行 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 上架闸门：四件齐全 / 白名单外文件 / 双口径摘要 / `manifestDigest`（blob vs worktree）/ `game.js ≤ 2 MB` | `check-package.mjs` | `--local-dir games/sacred-stones` 或 `--owner/--repo/--commit` | `distOnly = sha256:9243d0e4…`、`manifest = sha256:813b0a47…`、PASS exit 0 | 2026-10-30 04:0x PASS | 首次运行（历史上从未跑过） |
| 确定性：`version` 与 `bundleDigest(仅 dist/)` 必须同变 | `check-package.mjs --baseline tools/pkg-gate/baseline.json` | 基线 JSON（`gameId`/`version`/`commit`/`distFiles`/`bundleDigest`/`manifest`/`recordedAt`） | 一致 → PASS；version 变而摘要不变 → exit 1；摘要变而 version 不变 → exit 1 | 2026-10-30 04:1x（重记基线；两条失败路径各跑一次，均 FAIL exit 1） | 已证明会红 |
| 清单四桶（shared / onlyA / onlyB / fieldMismatch） | `compare-sets.mjs` | 两份 TSV（`0x`+8 位小写、一行一个、`#` 头注） | 275 线：`shared 275 / onlyA 0 / onlyB 0 / fieldMismatch 0`，exit 0 | 2026-10-30 04:0x exit 0 | 已跑（两份真实导出互比） |
| 四桶自证 + 判定与退出码同源 + `clean` 不是字段 | `compare-sets.mjs --self-test` | 无 | `self-test PASS (14 条)`；`'clean' in result === false` | 2026-10-30 04:2x | 已跑（`clean` 字段已删除，只留 `isClean()`/`verdictOf()`） |
| 删字段后的读取点清查（`\.clean\b` 全仓） | 无脚本，一次性 grep | `*.mjs/*.js/*.ts/*.tsx/*.py/*.md/*.json`（排除 `node_modules`/`dist`/`.git`/`.botharness`） | 全仓 **4 处命中、全在 `tools/lz77-diff/compare-sets.mjs` 的注释里**（`148/149/214/223`），**无任何活代码读 `result.clean`** | 2026-10-30 04:2x | 已查；**读取 `clean` 的位置已失效，改用 `isClean()`/`verdictOf()`** |
| 索引完整性（脚本必须进表或排除清单） | `check-index.mjs` | `docs/criteria-index.md` + 三个扫描目录 | 64 脚本 → 33 登记 / 30 排除 / 0 遗漏，exit 0 | 2026-10-30 04:1x（首跑 44 未登记 → 补齐后绿） | 新增，已跑 |

## 游戏包侧（`games/sacred-stones/`，游戏实现与逆向的）

| 判据 | 脚本 | 输入 | 期望值 | 最近一次运行 | 状态 |
| --- | --- | --- | --- | --- | --- |
| ROM 表头自检（checksum / title / code / 存档介质） | `fe8-scan.py` | ROM | `sha256 167ed579…`、checksum `0xD7` PASS、`FIREEMBLEM8 / BE8J`、`SRAM 32 KiB` | 2026-10-30（我代跑并贴原始输出） | 已跑 |
| 存档介质标识串 | `scan-backup-lib.mjs` | ROM | SRAM 32 KiB（SRAM_F_V） | 2026-10-30 | 已跑 |
| 指针引用枚举 + 洗牌基线（只读） | `fe8-pointers.py` | ROM | 指针字任意位置 159,591 命中 / 块 4,700；4 字节对齐 68,512 / 4,451 | 未记录 | 作者侧跑过，我无原始输出 |
| 自指针记录 + 两张 128 项表 | `fe8-selfptr.py` | ROM | `+0xC` 自指 284 = 256 链 + 19 散点 + 9 非对齐 | 未记录 | 作者侧 |
| LZ77 块枚举 + 闸门标签 + 自检 | `lz77-candidates.py` | ROM | 产出 `extract/lz77-pointers-4454.tsv` 与 `lz77-candidates.json` | 2026-10-30（清单 4454 入库） | 已跑 |
| 纯扫描召回上界（**不是清单**） | `lz77-scan-recall.py` | ROM | `4,933` 块 | 2026-10-30 | 已跑；只当召回上界 |
| 判据归因（先切总体再打标签，只追 `pass-all`） | `lz77-gate-attr.py` | ROM | 清单 `4,454`、资产 scope（`dlen>=32`）`4,450` | 2026-10-30 | 已跑 |
| 闸门标签（各判据命中分布） | `lz77-gate-labels.py` | ROM + 候选块 | 各闸门单独命中数与重叠关系 | 未记录 | 作者侧 |
| 变体探测（头字节/长度编码的其它解释） | `lz77-variants.py` | ROM | 用于确认 `head=0x10(exact)` 不放宽 | 未记录 | 作者侧 |
| 文本块筛选（`0x0A`/`0x0B` 控制码 + 索引上界给字库下界） | `text-blocks.py` | ROM | 文本候选块数（不依赖 BG1，与合成并行） | 未记录 | 进行中 |
| 文本块候选筛选（**只出 witness，不下结论**） | `text-blocks-witness.mjs` | ROM → 指针枚举 + LZ77 解块 | 数结构信号（控制码、字节多样性、结尾形态）并打 Top N 十六进制；**无判决**——分类已栽四轮，没有 ground truth 时任何打分只能在已知答案的样本上验证过才有意义 | 未记录 | 新增，作者侧 |
| 压缩比阈值标定 | `ratio-calibration.mjs` | ROM + 固定种子 | 洗牌噪声上界 `1.778`（种子 20261030，553 假阳性） | 2026-10-30 | 已跑；**ratio 只是诊断字段** |
| 清单逐行复算 + 头注 assert 计数 | `verify-lz77-tsv.py` | `extract/lz77-pointers-4454.tsv` | 4,454 行全过 | 2026-10-30（一跑就发现 flag 位序反） | 已跑 |
| 两份清单四桶 + 两桶畸形行 | `compare-block-lists.mjs` | 两份清单 | `4,454 ↔ 4,454` 全零、`malformed 0/0` | 2026-10-30 | 已跑 |
| 自指针清单四桶 | `compare-selfptr.py` | 两份自指针清单 | `shared 275 / onlyA 0 / onlyB 0` | 2026-10-30 | 已跑 |
| 「对方有我没有」的块逐条归因到闸门 | `attribute-only-blocks.mjs` | 两份清单 | 每条差异指名是哪道闸门挡住（闸门会重叠） | 未记录 | 作者侧 |
| 导出我接受的块清单（跨实现集合差用） | `export-block-list.mjs` | ROM | TSV 清单 | 未记录 | 作者侧 |
| 导出指针枚举块清单 | `dump-block-list.mjs` | ROM | TSV 清单 | 未记录 | 作者侧 |
| 解块 + 粗分类（产物进 `.botharness/blocks/`） | `dump-blocks.mjs` | ROM | 分类只是排序线索，不是结论 | 未记录 | 作者侧 |
| 同帧导出寄存器 + VRAM + 调色板 | `frame-export.mjs` | 运行中模拟器 | `extract/frame900.json`（寄存器/VRAM/调色板同帧快照） | 2026-10-30 | 已跑 |
| 帧转储完整性（`self_sha256`） | `frame900-selfcheck.py` | 帧转储 | 摘要与转储内自记值一致 | 未记录 | 作者侧 |
| 把帧转储渲染成层图/合成图（附 `vram_sha256`/`palette_sha256` 断言） | `render-frame.py` | `extract/frame900.json` | 产出 `extract/frame900/{bg1,bg2,bg3,composite}.png`，两处摘要断言通过 | 2026-10-30 | 已跑 |
| VRAM 判据（用运行中游戏的 VRAM 当标准答案对图块） | `vram-oracle.mjs` | 帧转储 + ROM 块 | 帧 900：`0xA1317E` 的 8 个图块命中 **0/8** | 2026-10-30 | 已跑 |
| 图块资产表（严格 `0x10` + `dlen>=32`） | `build-tile-assets.py` | ROM、`lz77-candidates.json`、`vram-tiles.bin` | `1,477` 命中 | 2026-10-30 | 已跑（仅差 `category` 列） |
| 单层 BG oracle（隔离后逐像素比） | `layer-oracle.mjs` | 帧转储 + 合成图 | 帧 900：BG1 `skip-blank`（**无判决**）、BG2 78 色（**正常**，见下）、BG3 15 色 | 2026-10-30 | 已跑 |
| 层掩码 oracle（层覆盖范围单独比对） | `layer-mask-oracle.mjs` | 帧转储 + 掩码 | 每层覆盖像素数一致 | 未记录 | 作者侧 |
| OBJ 单层 oracle | `obj-oracle.mjs` | 帧 3200（`DISPCNT=0x1300`） | 逐像素全等（修掉 OBJ 图块基址 `+0x10000`、调色板偏移 `0x200` 两个 bug 后）；**逐行不一致 0 行、OBJ 像素 14,819 = 硬件 14,819** | 2026-10-30（游戏实现用 lag-1 快照重跑） | 已跑；**旧报的「帧 3200 差 1,105 像素」是时序错，作废** |
| 逐扫描线 OBJ 上限（64 精灵/行、1024 像素/行） | `obj-oracle.mjs` 内的计数 | 帧 3200 | **该帧从未接近上限**：最忙一行 17 个精灵 / 228 px | 2026-10-30 | **未验证**——上限逻辑没被这帧行使过，全等不能证明它实现对 |
| 整屏 oracle（层间关系，不隔离） | `frame-oracle.mjs` | 新 dump（`vram 73025eda…`）+ 合成图 | 240×160 逐像素；`bldcnt` 四字段进 `summary.json`；**三条独立路径逐字相同**：BG1 opaque `12,574` / 混合可见 `11,643` / 盲区 `931` | 2026-10-30（新 dump 重出） | 已跑可当基线；旧 `13,515/14,564/1,049` 随旧 dump 退役 |
| 盲区（不可判区）必须由参照侧独立算 | 硬件 A/B：同一 savestate 只改 `BLDCNT`（`0x0c42` ↔ `0`）跑两次 | `frame900.json`（`c1fdc400…`） | 两次输出相同的像素 ∩ BG1 不透明 = `931`（分布在 10 个 16×16 块）；`computedBy: reference-side`（被测实现不参与） | 2026-10-30（游戏实现） | 已跑 |
| BLDCNT 改动必须证明“在渲染时生效”（帧末回读不可作证据） | `bldcnt-per-line.mjs` | 同一 savestate；两种配置（`0xc42` / `0`）各跑一次 | 逐扫描线渲染前强制写入时，`bldcntWhileRendering` 应分别为 `0xc42` / `0x0`；若帧末回读两次都读到 `0xc42`，说明改动被游戏在帧内改回，实验作废 | **未记录**（作者侧跑过，我没有原始输出） | 待作者补复现命令与两次 `bldcntWhileRendering` 原值；本行按“没跑过”读 |
| **改 IO 寄存器的实验必须证明"改动在渲染时生效"** | 渲染期取样：包 `renderScanline`，逐行写入后读回 | 同 savestate 跑两次 | 两次渲染期读数必须**不同**（`0xc42` vs `0`）；**帧末回读不可作证据**——游戏会在帧内把值写回，两次跑成同一配置时数字照样自洽 | 2026-10-30（游戏实现：第一版帧末回读两次都是 `0xc42`，实验被自己否掉；改逐行强制写入后才有证据） | 已跑；这条是"三段式对撞"的**前置闸门**，不通过不许报数 |
| 掩码/盲区集合级对撞（**判据取打包 sha，不取 PNG sha**） | 无（对撞按约定手工执行） | 240×160、行优先、白=1、MSB-first、行末补 0 到整字节 | `bg1-mask` 打包 `cb41549a…`、`blindzone` 打包 `4df02f1e…`，两侧逐像素 `onlyMine 0 / onlyImpl 0` | 2026-10-30 | 已跑；**PNG 文件 sha 不同只是编码器差异（RGB vs RGBA），不作判据** |
| **打包器约定已知答案向量**（两个独立打包器必须都复现，否则打包 sha 不能当判据） | `mask-pack/pack.mjs --selftest` | 手写向量：V1 `4×2` 字节 `90 60`；V2 `240×1` 首尾两列 `80 00…00 01`（30 B） | `V1 sha256:590ddde5444fee9a…`、`V2 sha256:4e7c5c4437b58d50…`；`self-test PASS (8 条)` | 2026-10-30 | 新增；预期值锚在**手写字节**上（取哈希不算打包），不是锚在某个打包器的输出上；第 8 条断言 LSB-first 版必须得 `09 06` 而非 `90 60` ⇒ **向量能区分 bit 序** |
| **掩码 bit 序分歧的判定**（同一像素集合、两种约定） | `mask-pack/pack.mjs`（MSB）vs `1<<b`（LSB） | `frame900/bg1-mask.png`、`frame900/bg1-blindzone.png`，240×160，4,800 B | MSB：`cb41549a…`（`12,574 px`）/ `4df02f1e…`（`931 px`）；LSB：`26a7999d…` / `99c0558d…`；**实测 `lsb == 逐字节 bit 反转(msb)`，两侧 4,800 B 逐字节成立** | 2026-10-30 | 已复核：两套 sha 不是内容差异，是表示差异；约定以 MSB-first 为准（`0x80>>b`） |
| 掩码打包接口形状（扁平数组 vs 二维 rows） | `mask-pack/pack.mjs --selftest`（第 9、10 条） | `packMask([0,1,0,1])`、`packMask([[0,255]])` | 两者都必须抛错且消息点名原因（`二维数组` / `0/1`） | 2026-10-30 | 该族 bug：形状不对仍算出「看着像 sha 的错值」；旧版对扁平数组静默出全零 |
| 参照副本是否漂移（副本 = 第二份真相） | `mask-pack/check-drift.mjs` | `git show <source_commit>:tools/mask-pack/pack.mjs` vs `git show <copy_commit>:games/sacred-stones/tools/mask-pack-reference.mjs`（各取该路径最后一次提交：本次 `8a1cc43` / `feb20d6`） | **两侧从 git 对象各自重算**的 sha256 必须相等；不等则 exit 1。产地章里的 `source_sha256`/`copy_sha256` **只作对照**（过期单独报一类），不作判定依据；工作区脏另报一类（脏 ≠ 漂） | 2026-10-30 | `drift PASS (1 对：从 git 对象重算一致)`，两侧 `cae1d81d9e32…`；三条失败面各跑一次：上游工作区加一行 → FAIL exit 1 且提示"先 commit 别 refresh"；`MASK_PACK_REFRESH_SCRIPT` 指向不存在路径 → FAIL exit 1 并指名路径（不再静默用工作区顶替）；正常 → PASS exit 0 |
| **dump 侧 sha（`registers_sha256`/`self_sha256`/`vram_sha256`）** | 无（需作者给规则） | 序列化规则须写明：字段顺序、是否含 JSON 空白、数值格式、`self` 字段如何置零 | 缺规则时**按"声明"读，不作判据** | 未记录 | 与 bit 序同一类问题：没有约定就无法独立复算；待游戏实现补一句规则后才可升为判据 |
| 帧比较（差异像素数与占比、边界框） | `compare-frame.mjs` | 实际图 + 期望图 | 输出差异像素数 / 占比 / 边界框 | 2026-10-30 | 已跑 |
| 出包前硬自检（无 `import`/`export`、无大块 `data:`、≤2 MB） | `check-dist.mjs` | `dist/` | 全过才允许产物进 Issue | 2026-10-30 | 已跑 |
| 打包 `dist/game.js`（iframe 只认三件白名单） | `build.mjs` | `src/app` | 单文件 bundle | 2026-10-30 | 已跑 |
| 与平台同口径的发布摘要 | `digest.mjs` | `dist/` | 与 `bundleDigest.ts:61-94` 逐字一致 | 2026-10-30 | 已跑 |

## 两处"悬空"必须写成**已解释**或**有下一步**（PM 2026-10-30 修正）

**BG2 78 色 —— 已解释，不是嫌疑：**

```
帧 900 观测：palette_banks = [0..10]，11 个 bank、每 bank ≤ 11 色   ← 观测值，不是判据
硬件上限：4bpp 文本模式 map entry 的 bit12–15 **逐图块选调色板 bank**
⇒ "16 色上限"是**每 bank** 的上限；层总色数 = 被引用的 bank 们的并集，上限 16 × bank 数
```

这两个数必须分开写：**`11` 是帧 900 的观测（进 `palette_banks` 明细），`16` 是硬件上限（进断言）**。
判据里出现"每 bank ≤ 11 色"就是把观测升格成了判据，换个帧就会假红。

可判定的硬约束（能抓 8bpp 误读 / 字节当索引，这两种错会给出单 bank >16 色或 index ∉ [0,15]）：
**每 bank 色数 ≤ 16 且 index ∈ [0,15]；`summary.json` 必须记 `palette_banks[]` + 每 bank 色数。**

**BG1 —— 无判决（oracle `skip-blank`），但机制已明：**

```
15 个不同索引全落 bank 15，palette_raw 全 0x0000 ⇒ 调色板未写入，不是"都索引到同一个调色板项"
几何是真的：274 图块确实被 tilemap 引用
⇒ 规格里不许写"BG1 是黑幕 / 恒黑"，只许写：BG1 图案来自 tilemap 引用的图块，
   颜色取自 palette bank 15；帧 900 该 bank 全零，故显示为黑
```

下一步**不是"找 bank 15 非零的帧"**（这游戏标题画面就不用 bank 15，可能永远等不到），而是**造状态**（PM 2026-10-30）：
用 `writeU16` 直接往 palette RAM 的 bank 15 写 16 个非零值（**不动 ROM**），再抓一帧与合成比。

```
写入后合成仍全等 ⇒ "颜色取自 bank 15" 的机制被证实
写入后不等     ⇒ bank 选择位（map entry bit12–15）或 bank 基址读错了
```

能构造反例时不要靠观察碰运气：构造出来的反例可重复、不依赖任何人去翻游戏流程。同理给游戏实现的"整 bank 15 刷洋红"是同一招的另一半。

## 帧 900 派生数字必须回答「哪份 dump」

> PM 2026-10-30 定：所有以帧 900 为输入的产物**必须自带 `vram_sha256` 标注**；表里每个数字旁边要能回答「哪份 dump」。
> 一行 sha 就能判断某张表是不是错帧来的，比记事本里的日期可靠。

**当前有效 dump**（游戏实现 `0169d4f`，时序 = 跑 899 帧 → 快照寄存器/内存 → 再跑 1 帧取 framebuffer）：

```
games/sacred-stones/extract/frame900.json   133,016 B
self_sha256   007cc645…
vram_sha256   73025eda…
palette_sha256 56890662…
```

**退役 dump**（`fe1ff5b`，寄存器取在最后一次 `runFrame()` **之后** ⇒ 存的是第 901 帧的寄存器配第 900 帧的画面）：

```
vram_sha256 94a525d6…   bghofs [0,169,3,0]（新 dump 为 [0,156,6,0]）
```

判据不是谁说的，是硬件的：同帧同口径下，游戏实现用新时序算出整屏 `diffPixels: 0`，用旧时序差 7,456 像素（19.4%）。

**帧 900 的 `(a) == bg1Opaque` 为什么成立（2026-10-30 游戏实现实测）**：该帧 `objPaintedPixels = 0`、`objAboveBg1Opaque = 0`、`bg1Priority = 1`
⇒ **这一帧根本没有 OBJ 像素**，所以"混合分支数恰好等于 BG1 不透明像素数"不是漏了遮挡判定，而是遮挡不存在。
别把这句推广成"OBJ 遮挡可以忽略"：它只是第 900 帧的空集。

**退役数字（不得再引用）**：`layer1_opaque 14,564` / `A/B 13,515` / `same_result 1,049` / `bg1-mask.png e05ab951…` / `bg1-blindzone.png 349a570c…`，
以及逆向据旧 dump 出的资产表 `1,477 行`、命中块 `342`、`0xB5EFDC 255/255`、三层「38,400 像素全等」——**强证据也可以建立在错帧上，强度不传递。**

**掩码类产物的 sha 必须带约定**（PM 2026-10-30）：`summary.json` 里要有

```
mask_convention { width 240, height 160, row_major, bit_source, msb_first, pad }
  bg1-mask   → bit_source = 'bg1-opaque'
  blindzone  → bit_source = 'same-result'   （两侧输出相同的像素，不是"层不透明"）
```

否则半年后有人手里只有一个 `4df02f1e…`，既不能复算、也无法判断"我该不该得到同一个值"——**一个脱离了约定的 sha，和没有 sha 是一回事。**
同理：**判据取打包 sha（1 bit 掩码），不取 PNG 文件 sha**；PNG 的差异只是编码器（RGB vs RGBA），不是内容差异。
但打包 sha 本身也要先被验证：两侧各写各的打包器时，「同一个像素集合给出四个不同 sha」只说明**约定有分歧**，不说明内容不同
⇒ **打包 sha 只有在双方都复现已知答案向量（`tools/mask-pack/pack.mjs --selftest`：V1 `90 60` / V2 `80 00…00 01`）之后才能当判据**，
在此之前判据仍是像素集合 + 对称差，且每份掩码文件必须记**产出它的打包器版本**——否则明天换了打包器，没人说得清 sha 变的是"表示"还是"内容"。

**新 dump 落地后只重出一次，并交 `old_sha → new_sha` 对照表**：每行写产物名、旧 sha、新 sha、内容是否变化、变化原因。
内容不变只是输入 sha 变了 ⇒ 写「仅标注变更」；内容变了 ⇒ 必须能指出是哪一步导致的。
旧产物按老规矩 retired：文件保留、头部标 `retired`、**本索引只指向新 sha**——不留第二份可引用的产物，否则两份都在，下次一定有人引用错的那份。
（顺序：OAM 一次加到齐（`format_version: 2` + `oam_base64` 1,024 B + `oam_sha256` + `registers_sha256`）之后才重出，不要再付第二次成本。）

以下行依赖帧转储，**引用它们时必须同时给出 `vram_sha256`**：`frame-export.mjs`、`frame900-selfcheck.py`、`render-frame.py`、`vram-oracle.mjs`、`build-tile-assets.py`、
`layer-oracle.mjs`、`layer-mask-oracle.mjs`、`obj-oracle.mjs`（帧 3200，另一份 dump）、`frame-oracle.mjs`、`compare-frame.mjs`。
现在它们的「最近一次运行」写的是旧 dump 的日期 ⇒ 在作者用 `73025eda…` 重出之前，一律按**未验证**读。

## 排除清单（不属当前判据，因此不登记为判据行）

> 规则：这里每一项都必须写原因。`check-index.mjs` 认这一节，但**不认没有原因的条目**。

- `arena-browser-qa.mjs` — 猫斗场浏览器 QA，一次性人工验证
- `arena-real-model-qa.mjs` — 猫斗场真实模型 QA，一次性
- `audit-assembler-policy.mjs` — 一次性装配策略审计
- `audit-wire-consistency.mjs` — 一次性线缆/协议一致性审计
- `backup-gamecenter-db.mjs` — 运维备份工具，不是判据
- `cats-assembly-browser-qa.mjs` — 猫猫 APK 移植期 QA
- `cats-browser-qa.mjs` — 猫猫 APK 移植期 QA
- `cats-qa-server.mjs` — 猫猫 QA 用临时服务
- `cats-wallet-browser-qa.mjs` — 鲸鲸币浏览器 QA（历史）
- `collect-candidate-manifest.mjs` — 收集候选清单，一次性
- `collect-game-release.mjs` — 收集 release 信息，一次性
- `extract-cordis.mjs` — 注入探针：历史问题定位用
- `extract-typert.mjs` — 注入探针：历史问题定位用
- `gateway-dispatch.mjs` — 注入探针：历史问题定位用
- `repro-inject-guard.mjs` — 注入探针：复现脚本
- `repro-remote-claims.mjs` — 注入探针：复现脚本
- `verify-browser-cordis.mjs` — 注入探针：复现脚本
- `decode-cats-raw.mjs` — 猫猫原始资源解码，一次性
- `flash-browser-qa.mjs` — 闪客快打4 浏览器 QA
- `flash-full-client-qa.mjs` — 闪客快打4 全量客户端 QA
- `gamecenter-library-browser-qa.mjs` — 游戏库 UI QA
- `library-search-browser-qa.mjs` — 游戏库搜索 QA
- `inspect-cats-apk.py` — APK 结构分析，一次性
- `unpack-cats-apk.py` — APK 解包，一次性
- `probe-host-entry.mjs` — 宿主入口探针，一次性
- `package-arena-candidate.mjs` — 打包候选产物（猫斗场）
- `package-cat-arena.mjs` — 打包候选产物
- `package-flash-candidate.mjs` — 打包候选产物
- `package-landlord-candidate.mjs` — 打包候选产物
- `package-library-candidate.mjs` — 打包候选产物
- `rom-frame-proof.mjs` — 游戏实现新增的帧证明脚本；我未跑过、不清楚它的输入与期望值，**按排除处理并在此留痕**，待作者补一行正式判据行（若它其实是判据，这条就该被删掉）
- `blindzone-legacy-probe.mjs` — 游戏实现 2026-10-30 新增的“旧盲区口径”探针；**我没有它的期望值、也没跑过**，`check-index` 于 05:0x 首报未登记。按排除留痕，待作者说明它是判据还是临时探针——若是判据（应当能给出 pass/fail）就补一行正式判据行并删掉本条
- `refresh-mask-pack-copy.mjs` — 只读副本的**唯一写者**（字节取自 `git show HEAD:<path>`，非工作区）；`tools/mask-pack/check-drift.mjs --refresh` 已改为委托它，二者不是并列的判据脚本

## 口径提醒（三个容易记错的数）

- **`9243d0e4…` 不是"和 14 MB 那份撞值"**（那是另一个游戏的产物，不可能同值）。真相是：它与 2026-10-30 01:2x 那个 110,600 B 的壳
  **逐字节相同**（`game.js` 104,793 + `index.html` 2,303 + `style.css` 3,504），即 **`dist/` 自 `c52192f` 以来一个字节没动、W 版前端还没落到 `dist`**。
  后果：把它抄进 Issue，等于**把 R 期模拟器壳登记成 W 版游戏**。
- `275` 是 `self-pointer hits, 4B-aligned window` —— 扫描窗口属性，不是类别规模。
- **OBJ 调色板起始偏移 = `0x200`（512 字节）。** 文档中不得出现"`256` 与 `0x200` 同值"这类表述：`0x100` 是 BG 第 8 个 bank 的**起点**（`0x100 / 0x20 = 8`），不是"半格错位"，两者症状不同（半格→每档偏一格；取到 BG 后半段→只在 BG bank 8–15 有内容时才错，空时表现为"图块没找到"）。
