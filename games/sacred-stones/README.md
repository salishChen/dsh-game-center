# 火焰之纹章 圣魔之光石（网页版）

把 GBA 卡带里的游戏跑在浏览器里，带双存档池（手动无上限 / 自动 5 分钟一次、最多 20 份、满则删最旧）、关闭时自动存档。

**卡带文件由玩家自己提供**：本仓库不含 ROM，也不含任何从 ROM 提取的素材或文本。页面里选一次 `.gba` 文件即可，之后可以复用它（存在你本机的 IndexedDB，随时可「忘掉」）。

## 怎么跑

```bash
pnpm install
pnpm --filter @dsh-games/sacred-stones run build   # 产出 dist/ 三件
pnpm --filter @dsh-games/sacred-stones test        # 单元测试
```

`dist/index.html` 直接开也能玩（需要浏览器允许本地文件读取），装进游戏中心则走 `gamecenter.json`。

## 结构

| 路径 | 干什么 |
| --- | --- |
| `src/app/boot.js` | 内核启动：替内核扮演 BIOS（设各模式栈指针 + 跳到 0x08000000） |
| `src/app/renderer.js` | 内核 framebuffer → canvas，零转换直搬 |
| `src/app/keyboard.js` | 键盘 → GBA 十颗按键 |
| `src/app/rom-cache.js` | 卡带缓存（本机 IndexedDB） |
| `src/app/main.js` | 接线：定步长循环、存档 UI、生命周期 |
| `src/core/kernel-adapter.js` | 唯一接触内核的地方，换内核只改这里 |
| `src/save/*` | 存档池、自动存档、IndexedDB 适配、savestate 桥 |
| `src/core/address-table.js`、`src/core/memory-access.js` | 按地址表安全读写游戏内存（W 路线 / 深度改动才需要） |

## 几条不能破的规矩

1. **定步长 60Hz**，不用 rAF 的时间差推模拟。步长一变，逐帧回放就对不上。
2. **savestate 必须 `structuredClone`**，禁止 JSON 往返（TypedArray 会退化成普通对象）。
3. **两个存档池同格式**，不做「自动档只存轻量档」的降级：SRAM 里只有存档点，那样会变成跳档。
4. **ROM 永不入 git**，素材/文本同样不随仓库分发。
5. **坏档不覆盖好档**，版本不符要显式告诉玩家。
6. 鲸鲸币只上报事件，金额与上限在平台侧，游戏不许自报收入。

## 已知边界

- 内核是纯 JS 实现的 `@gba-kit/gba-emulator@0.8.0`（MIT）。它的准确度**没有**第三方背书：我们证明的是「与 mGBA 一致」，不是「与真机一致」。
- 浏览器关闭时异步写不保证完成，所以存档在页面「变隐藏」时就写一次，而不是只赌 `unload`。
