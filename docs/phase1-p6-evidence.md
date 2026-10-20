# 阶段1 P6 跨进程与原子检查点证据（2026-10-19）

证据分栏：`UNIT`（协议判定）+ `MOCK`（目录/审批 fixture）+ 真实子进程与真实 SQLite 文件。

## 1. 冻结的检查点契约（`packages/protocol/src/checkpoint.ts`）

| 项 | 定义 |
| --- | --- |
| `CheckpointRequest` | `{ operationId, expectedRevision, state, elapsedGameMs, rngState }` |
| 结果 | 成功 `{ ok:true, revision, idempotentReplay }`；失败 `{ ok:false, code, message, currentRevision? }` |
| 判定 | `decideCheckpoint()`：幂等重放 / 写入 / 拒绝三态 |
| 幂等键 | `checkpointIdempotencyKey()`：`playerId|gameId|saveId|operationId` 四段，`|` 做转义 |
| 内容摘要范围 | `canonicalCheckpointContent()`：覆盖 `state`、`elapsedGameMs`、`rngState`、`gameStateSchemaVersion`、`installedCommit` |

**PM 明确的两条，已落成可测规则**：

1. **不能只比 `state`**：改 RNG / 虚拟时间 / 状态结构版本 / 固定提交，都必须改变规范内容（否则同 operationId 会被误判为幂等重放，静默丢弃进度）。有 4 条断言逐字段验证。
2. **幂等键按玩家/游戏/存档绑定**：裸 `operationId` 作主键会跨存档串号；四段组合 + 分隔符转义，有 2 条断言（跨维度不同、分隔符注入不能伪造）。

协议测试：**37/37**（新增 4 项作用域与摘要覆盖用例），`typecheck` 退出码 0。

## 2. P6-8 跨进程证据（真实独立子进程，不是同进程 new Store）

父进程 `12036`。实际执行输出：

```
PROCESS_A childPid=26264 selfPid=26264 exit=0 revision=3
PROCESS_B childPid=12824 exit=0 readRevision=3 continuedRevision=4
DISTINCT_PIDS=true PARENT_PID=12036
STATE_EQUAL=true RNG_EQUAL=true TIME_EQUAL=true
```

可核事实：

| 判据 | 值 |
| --- | --- |
| 进程 A 的 OS PID | `26264`（子进程自报 PID 与父进程 spawn 返回一致） |
| 进程 A 退出码 | `0`（已正常结束） |
| 进程 A 写入 revision | `3`（连写 3 次） |
| 进程 B 的 OS PID | `12824`，与 A 不同，也与父进程不同 |
| 进程 B 读回 revision | `3` |
| 进程 B 继续写入 | `4`（**未回退**） |
| 棋盘状态 | 跨进程 `deepEqual` 一致 |
| 虚拟时间 / RNG | 跨进程一致 |

测试实现：`spawn(process.execPath, [childScript, dbPath, repoRoot, ...])`，父进程只通过 stdout 读子进程的 JSON 结果；断言 `writer.pid !== process.pid`、`writer.pid !== reader.pid`、`exitCode === 0`。

> 说明：Windows 上进程退出后 PID 可能被复用，`process.kill(pid, 0)` 不可靠，因此**不把信号探测**作为"进程已死"的判据，改用 `close` 事件的 `exitCode === 0` + 子进程自报 PID 与 spawn 返回值一致。

## 3. P6-9 并发竞争（两个独立子进程抢同一 expectedRevision）

| 判据 | 结果 |
| --- | --- |
| 两进程同时以 `expectedRevision=0` 写入 | **恰好一个成功**，revision=1 |
| 另一个 | `STALE_RUNTIME` |
| 库内最终 revision | `1`（未被覆盖成 2） |

## 4. P6-10 幂等（同进程，真实 SQLite 文件）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 同 operationId + 同内容重放 | 返回原 revision=1，不 +1 | PASS |
| 同 operationId + 改 state | 拒绝 `PROTOCOL_INVALID` | PASS |

**已知缺口**：`WriteCheckpointResult` 未回传 `idempotentReplay` 标记（行为已对，标记缺失）。测试只断言可观测行为，不拿未实现字段凑绿；该字段已要求 Host 补。

## 5. 尚未完成（不认 P3 全闭环）

| 项 | 状态 |
| --- | --- |
| 事务中断（真实 SQLite 中途抛错 → ROLLBACK 保持旧 revision） | Host 未交付 |
| 损坏 payload 拒读为 `PROTOCOL_INVALID` | Host 未交付 |
| `idempotentReplay` 回传 | Host 未交付 |
| 真实 DSH 内关闭恢复（A6 实机） | 需部署授权，未做 |

## 6. 复现命令

```bash
pnpm run test:integration   # 含 build:staging，不触碰 lib/
pnpm -C packages/protocol test
```

`build:staging` 实测不改变 `lib/index.js`（哈希与 mtime 均不变），产物只落 `staging/`。
