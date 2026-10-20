# 重启前可续接记录（架构与协议负责人，2026-10-20）

用户已授权**一次整体 DSH 重启**，用于让运行中的宿主加载当前磁盘候选 + 隔离配置。本文件在重启可能中断会话前写入，供新会话接续。**本文件在候选冻结范围之外。**

## 1. 重启前现场（已实测）

| 对象 | 现值 | 说明 |
| --- | --- | --- |
| Host `packages/dsh-gamecenter/lib/**` | 27 文件，TREE32 `DB75E014DA0BEFFA48CC6E50EE5DB33E`，`index.js` = `678015D69FBE6D2AE045FF3732169D433890E77636A73D64E28F5AB61917BD74` | 新候选已在磁盘 |
| Client `packages/dsh-gamecenter-client/dist/client.js` | `D028706B815EB24A212054B606CB0D25F78BE7710B3E0A2F972EFC25B1804558`，134,048 字节 | 新候选已在磁盘 |
| profile `cordis.yml` | `27DAA47ED5C40F59DAA882A3D41B9FC00ACBF3CE52D3662D436477B6770264B9`，53,539 字节 | 含 `gamecenter-host.config: {playerId: acceptance-phase1, dataDir: C:\Users\salis\.dsh\gamecenter-acceptance\phase1}` |
| 备份 | `C:\Users\salis\.dsh\gamecenter-acceptance-backup-20261019-223152\` | `lib/` TREE32 `6381300D…`、`client.js` `427F79EA…`、`cordis.yml` `4EF36E1F…`（均已校验） |
| 隔离库 | `C:\Users\salis\.dsh\gamecenter-acceptance\phase1\gamecenter.sqlite`（20,480 字节） | 由架构侧 `apply()` 验证性装配创建，**保留不删**；后续验收不称“首次空库启动” |

## 2. 运行中进程（重启前）

- PID 27748 `DeepSeek Harness.exe`，监听 `0.0.0.0:3080`（TCP LISTENING，属主 27748）。
- 该进程**未**加载磁盘新代码（QA 实测：未创建隔离目录、未持有 sqlite 句柄、无 dev watcher）。
- GUI `http://127.0.0.1:3080/` 未认证时返回 401；不能据此判断版本。

## 3. 受支持启动入口（实读证据）

- `C:\Users\salis\.dsh\desktop-launcher\launcher.ps1:127-130`：
  ```powershell
  $arguments = @('web')
  if ($profile -ne '') { $arguments += @('--profile', $profile) }
  Start-Process -FilePath $command.Source -ArgumentList $arguments -WindowStyle Hidden
  ```
  `$profile` 在本机为空串（脚本第 4 行 `$profile = ''`），因此启动命令为 **`dsh web`**，并轮询 `http://127.0.0.1:3080` 直到 `StatusCode` 在 200..499。
- 命令解析：`C:\Users\salis\AppData\Roaming\npm\dsh.cmd`（`where dsh` 的首个命中）。
- 停止方式：**未找到受支持的 CLI stop/restart 子命令**。本次只做“关闭唯一宿主进程 → 用上面的 `dsh web` 重新启动”，不批量杀 Node、不强杀、不循环重启。

## 4. 重启操作步骤（执行一次）

1. 再次校验 §1 三个哈希与备份仍在位。
2. 优雅关闭 PID 27748（单一进程，且已确认它是 3080 的唯一监听者）。
3. 用 `cmd /c` 后台启动 `dsh web`（工作目录与 npm 全局 bin 一致），等待 60 秒内 3080 重新可达。
4. 新 PID 与端口归属、隔离目录是否被新进程创建/写入、13 个 Remote 端点、Client bundle 版本。
5. 失败不重复重启：停报并请用户手动启动（或按 R1 恢复现场，需另报授权）。

## 5. R1 恢复现场（如需要，按已批清单）

- `lib/` 还原自备份（TREE32 应回 `6381300D1A8CB50DC44C642A3B7D99B8`）；
- `dist/client.js` 还原为 `427F79EA…`；
- `cordis.yml` 还原为 `4EF36E1F…`（53,435 字节）；
- **另需一次重启才生效**（回滚不自动生效），该重启**另需授权**；
- 不执行回滚 B（删除 6 个 storage 文件），需单独授权。
