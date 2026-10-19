# Host 部署清单（冻结）

生成时间：2026-10-19。生成人：架构与协议负责人。
用途：供部署执行人（DSH Host工程师）机械核对，**不代替用户授权**。

> 脱敏说明：本文件中的 `<REPO>`、`<PROFILE_DIR>`、`<USER_HOME>`、`<DSH_INSTALL>` 是路径占位符，**不是可直接执行的路径**；文中所有摘要值取自脱敏前的原始样本，未按替换后的文本重算。

## 0. 冻结校验（部署前必须重跑一遍）

本清单生成时实测：

| 项 | 值 | 状态 |
| --- | --- | --- |
| `packages/dsh-gamecenter/staging/` 整树摘要 | `CB4DDE0DB452C03C666EC1E05F218BA6` | 未漂移 |
| 在线 `packages/dsh-gamecenter/lib/` 整树摘要 | `EB2D9A2B9CF2611ED5F45C376A836E89` | 未漂移 |
| 文件数 | staging 21 / lib 21 | — |
| lib 独有孤儿文件 | 0 | — |
| 发生变化的文件 | 9 | — |

整树摘要算法（可复现）：对每个文件取 `相对路径(正斜杠) + ':' + 该文件 SHA-256`，按相对路径升序拼接，
以 `\n` 连接后取 UTF-8 字节的 SHA-256，取前 32 位十六进制。

> 若部署前重跑，任何一项不等于上表，**停止部署并报告**，不得重算候选去凑摘要。

## 1. 变化文件（部署必须覆盖这些，且必须整树覆盖）

```
index.d.ts
index.js
index.js.map
dsh-adapter/protocol.d.ts
dsh-adapter/protocol.js
dsh-adapter/protocol.js.map
remote/game-center-service.d.ts
remote/game-center-service.js
remote/game-center-service.js.map
```

**为什么必须整树覆盖**：只替换 `index.js` 会让 `lib/remote/game-center-service.js` 保持旧版
（仍含恒返回 `null` 的协议加载器与 `Remote()` 空参缺陷），404 会原样复现，而现场会误判为"已部署"。

## 2. staging 全量清单（21 文件，SHA-256 全值）

```
ai/model-catalog.d.ts            CC7357BD539BE366DB8E2051278C3714F91DE09694765C281CC0E6A447F27B86
ai/model-catalog.js              8D63C278920D2E22D1F8C39D46143C6CF868A34B6FB4EC815F88B01091789EA4
ai/model-catalog.js.map          9E7BC64A16F43DF5B2DBA481C4EE87B34762CBF4D6BEC87D7B81900D21D2E795
dsh-adapter/context.d.ts         224C3A62403D25AAE5738728C23222160F498426392AF049FA5984333234298D
dsh-adapter/context.js           2170C054CB4A1E064B14487A0450025E32678EA2D658255BBA0633965E52CD4E
dsh-adapter/context.js.map       04B4C0D51BC9C35B61B921078C33872EB22CD691C8C12D4F1A688C86190E69A2
dsh-adapter/protocol.d.ts        0D72BEBA25415332BA211130F70C8D4BC4A21C1729105EBCEACFA0D8964C57F6
dsh-adapter/protocol.js          0EE0E675B58DE298E4D2CBB16C8A17EECBA37549C49D2C60C3385B64200BF8E9
dsh-adapter/protocol.js.map      EFC56BE8848EA168201F4797A80B279A90B6D316ED048C07EBA74A87A2BDFC5E
index.d.ts                       174777C52A0984BEDBD78F9BEC04A61848191B2A2C8B13EC322778CDB152E0A4
index.js                         93F30A7B51B8D857CF4B722B56F54E54986F7B520C2E38E76AE23A609BFA5222
index.js.map                     B0FCAED009E28483A2DCF5A62E34CE49BB9491B713DA5CB0315C1328DFA86EC9
remote/contribution-shape.d.ts   66B99E52514257D09385CB2AB1F0B6059C2265566DC529391684759A4A1CCD31
remote/contribution-shape.js     B189CB59BC0D936746D182C11053C52B3695BDFD47C1937186E9A12B924A2EF4
remote/contribution-shape.js.map AA68B8CD090A90B3EEE0EDA3E0F40AC9490E310CB4A299CEDCE9DEA4249113C8
remote/game-center-service.d.ts  1A057B67122C97998A4C26CCD2E094CD9544F0F971A8B5A1F22029B8B9D011D1
remote/game-center-service.js    00D8351F3F78322B771663461843A68B367AF073735E73F2E08920CF93F47221
remote/game-center-service.js.map F23B2CE2268D0A865EDA5301D816C62D73DB23296920E65547A968EFA7C9DB43
runtime/lease.d.ts               701DD53161BEA24867256B592978F665E4C8ACDF5983B52F9C998B939E911136
runtime/lease.js                 EEB28A6B5B414A311A02E9BC41014477B860666823291A50A0E5A86C29572914
runtime/lease.js.map             16857819B473D85AAA4A637AE6CE6E77869085BE7D93ABEE2C4715E8B90ECDA3
```

## 3. 部署步骤（须先获得用户授权）

1. 重跑第 0 节冻结校验，两项摘要必须与上表一致；
2. 新建**不覆盖**的备份目录，整份复制当前 `lib/`，记录其整树摘要 `EB2D9A2B…`；
3. 用 `staging/` **整树**覆盖 `lib/`（21 文件），不新增、不遗漏；
4. 校验 `lib/` 整树摘要 = `CB4DDE0DB452C03C666EC1E05F218BA6`；
5. 校验 `lib/` 无 staging 之外的多余文件；
6. **正常退出并重开 DSH 桌面进程**（Host 插件在进程启动时装载，页面刷新无效）；
7. 重启后打开游戏中心重跑诊断，记录 7 项指标；重点看 `handshake` / `modelCatalog` 是否仍 404。

**回滚**：用第 2 步备份整份覆盖 `lib/`，再正常重启；回滚后整树摘要应回到 `EB2D9A2B…`。

## 4. 不在本清单范围内（明确不改）

- Client：`packages/dsh-gamecenter-client/dist/client.js` 保持 `1BE7FDA8…`（页面加载即生效，无需重启）；
- profile：`<PROFILE_DIR>\` 下 `package.json`、`cordis.patch.yml` 与软链；
- 模型与凭据配置；不调用任何付费模型。

## 5. 证据分栏

部署与重启后得到的观测才算 `DSH-REAL`。本清单之前的一切（含 `gateway-dispatch.mjs` 的真实 Gateway 分派）
属于 `STATIC + UNIT + MOCK`，**不能作为阶段0 通过依据**。
