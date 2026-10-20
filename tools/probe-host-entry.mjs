#!/usr/bin/env node
/**
 * Host 生产默认入口动态探针（架构与协议负责人维护，只读源码、只写临时目录）。
 *
 * 目的：PM 要求的"生产默认入口动态联合验收"中属于我这一半——不经过测试直调 Store，
 * 而是走真实 `apply()` 装配 → 真实 `@Remote` 方法 → 真实 SQLite → **新进程**读回。
 *
 * 同时实测四个必须拒绝的负例（PM 2026-10-20 要求）：
 *   N1 相对 dataDir 必须被拒，且 cwd 不得出现新目录
 *   N2 缺 playerId 必须被拒
 *   N3 saveCheckpoint 入参出现 playerId 必须被拒
 *   N4 暂停后旧代次写入必须被拒
 *
 * 证据分栏：本脚本产出 MOCK/BUILD 级证据（本机 Node + 真实 staging 产物），
 * **不是** DSH-REAL：没有在 DSH 进程内执行，也没有真实 Gateway 网络调用。
 *
 * 用法：node tools/probe-host-entry.mjs [--json]
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STAGING_INDEX = path.join(ROOT, 'packages/dsh-gamecenter/staging/index.js')
const asJson = process.argv.includes('--json')

/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = []
/** @param {string} name @param {boolean} ok @param {string} detail */
const record = (name, ok, detail) => results.push({ name, ok, detail })

/**
 * 真实 Cordis Context。
 *
 * 必须用真的：`TypertRemoteService` 继承 Cordis `Service`，构造期会访问 `ctx.provide`；
 * 手写的最小 stub 会抛 `Cannot read properties of undefined (reading 'provide')`
 * （2026-10-20 实测），因此**默认生产入口只能在本项目之外用真实 Context 装配**。
 * 这与 DSH 运行时一致，但我们仍**不**把它叫做 DSH-REAL：这里是本机 Node + 真实 Cordis 库。
 */
const hostRequire = createRequire(path.join(ROOT, 'packages/dsh-gamecenter/package.json'))
const cordisPath = hostRequire.resolve('@deepseek-ai/cordis')
const { Context: CordisContext } = await import(pathToFileURL(cordisPath).href)

function makeCtx() {
  return new CordisContext()
}

const dirs = []
const mkdtemp = (prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * 生成一个符合协议 `isLaunchTokenShapeValid` 的启动令牌（43 字符 base64url 量级）。
 * 探针用固定随机源即可：这里验证的是**协议形状与绑定关系**，不是熵质量。
 * @param {string} tag
 */
const launchTokenOf = (tag) => `probe-launch-${tag}-`.padEnd(43, 'x').slice(0, 43)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 统计当前进程某时刻的 pending 租约数量（只读 registry）。 */
const pendingLeases = (core) => core.registry.all().filter((lease) => lease.state === 'pending')

let apply
try {
  ;({ apply } = await import(pathToFileURL(STAGING_INDEX).href))
  record('装配 staging/index.js', true, 'apply 可加载')
} catch (error) {
  record('装配 staging/index.js', false, `import 失败：${error.message}`)
}

if (apply) {
  // ---- 正例：真实入口 → handshake → saveCheckpoint → 新进程读回 ----
  const dataDir = mkdtemp('dsh-gc-probe-')
  let api = null
  try {
    api = apply(makeCtx(), { dataDir, playerId: 'player-probe-1', catalogMode: 'fixture' })
    record('N0 默认入口装配（显式 dataDir/playerId）', true, `sqlite 存在=${existsSync(path.join(dataDir, 'gamecenter.sqlite'))}`)
  } catch (error) {
    record('N0 默认入口装配（显式 dataDir/playerId）', false, `apply 抛错：${error.message}`)
  }

  if (api) {
    const handshake = api.core.handshake({
      runtimeInstanceId: 'rt-probe-1',
      nonce: 'nonce-probe-1',
      launchToken: launchTokenOf('probe1'),
      gameId: 'example.minesweeping',
      gameVersion: '1.0.0',
      sdkVersion: '1.0.0',
      bridgeVersion: 1,
      // 存档槽位自 2026-10-20 起是**握手必填**，Host 不再回退 runtimeInstanceId。
      saveId: 'save-default',
    })
    record('N0b 握手取得 runtimeToken', handshake.ok === true && typeof handshake.runtimeToken === 'string', JSON.stringify({ ok: handshake.ok, generation: handshake.generation, errorCode: handshake.errorCode }))

    const token = handshake.runtimeToken
    if (typeof token === 'string') {
      const write = await api.service.saveCheckpoint({
        runtimeToken: token,
        operationId: 'act-probe-1',
        expectedRevision: 0,
        state: { board: 'x' },
        elapsedGameMs: 123,
        rngState: 'seed:probe',
      })
      record('N0c saveCheckpoint 真实写入', write.ok === true, JSON.stringify(write).slice(0, 160))

      // 新进程读回（跨进程证明"落盘"而不是内存）
      const reader = `
        import { DatabaseSync } from 'node:sqlite'
        const db = new DatabaseSync(process.argv[1], { readOnly: true })
        const rows = db.prepare('SELECT key, revision FROM gamecenter_saves').all()
        console.log(JSON.stringify(rows))
      `
      const readBack = spawnSync(process.execPath, ['--input-type=module', '-e', reader, path.join(dataDir, 'gamecenter.sqlite')], {
        encoding: 'utf8',
      })
      const rowsText = (readBack.stdout || '').trim()
      let ok = false
      let detail = `exit=${readBack.status} stderr=${(readBack.stderr || '').slice(0, 120)}`
      try {
        const rows = JSON.parse(rowsText)
        ok = Array.isArray(rows) && rows.length === 1 && Number(rows[0].revision) === 1
        detail = `新进程读到 ${rows.length} 行，revision=${rows[0] && rows[0].revision}，key=${rows[0] && rows[0].key}`
      } catch {
        /* 保留原始 detail */
      }
      record('N0d 新进程读回同一 revision', ok, detail)

      // ---- N3：入参出现 playerId 必须被拒 ----
      const spoof = await api.service.saveCheckpoint({
        runtimeToken: token,
        operationId: 'act-probe-spoof',
        expectedRevision: 1,
        state: { board: 'y' },
        elapsedGameMs: 1,
        rngState: 's',
        playerId: 'attacker',
      })
      record('N3 入参带 playerId 被拒', spoof.ok === false && spoof.errorCode === 'PROTOCOL_INVALID', JSON.stringify(spoof).slice(0, 160))

      // ---- N4：暂停后写入准入（pausing 允许最终检查点），旧代次必须被拒 ----
      const paused = api.service.pause({ runtimeToken: token, reason: 'probe-close', generation: handshake.generation })
      record('N4a pause 进入暂停流程', paused.accepted === true, JSON.stringify(paused).slice(0, 160))

      const finalWrite = await api.service.saveCheckpoint({
        runtimeToken: token,
        operationId: 'act-probe-final',
        expectedRevision: 1,
        state: { board: 'final' },
        elapsedGameMs: 200,
        rngState: 'seed:final',
      })
      record(
        'N4b pausing 允许本轮最终检查点',
        finalWrite.ok === true && Number(finalWrite.revision) === 2,
        JSON.stringify(finalWrite).slice(0, 160),
      )

      const staleWrite = await api.service.saveCheckpoint({
        runtimeToken: token,
        operationId: 'act-probe-stale',
        expectedRevision: 2,
        state: { board: 'stale' },
        elapsedGameMs: 300,
        rngState: 'seed:stale',
        generation: Number(handshake.generation) - 1,
      })
      record('N4c 旧代次写入被拒', staleWrite.ok === false && staleWrite.errorCode === 'STALE_RUNTIME', JSON.stringify(staleWrite).slice(0, 160))

      // ---- saveAck 必须以已持久 revision 确认 ----
      const ack = api.service.saveAck({ runtimeToken: token, revision: 2, generation: handshake.generation })
      record('N4d saveAck 按已持久 revision 封存', ack.accepted === true, JSON.stringify(ack).slice(0, 160))

      const afterSeal = await api.service.saveCheckpoint({
        runtimeToken: token,
        operationId: 'act-probe-after-seal',
        expectedRevision: 2,
        state: { board: 'after' },
        elapsedGameMs: 400,
        rngState: 's2',
      })
      record(
        'N4e 封存后写入被拒',
        ack.accepted !== true ? false : afterSeal.ok === false && afterSeal.errorCode === 'STALE_RUNTIME',
        ack.accepted !== true
          ? `前置失败：saveAck 被拒（${ack.error && ack.error.code}），租约未封存，本条无法成立`
          : JSON.stringify(afterSeal).slice(0, 160),
      )

      // ---- N5：缺 saveId 的握手必须被拒（不再是隐式回退 runtimeInstanceId） ----
      const noSlot = api.core.handshake({
        runtimeInstanceId: 'rt-probe-noslot',
        launchToken: launchTokenOf('auto'),
        nonce: 'nonce-probe-noslot',
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
      })
      record(
        'N5 握手缺 saveId 被拒（PROTOCOL_INVALID）',
        noSlot.ok === false && noSlot.errorCode === 'PROTOCOL_INVALID' && noSlot.runtimeToken === undefined,
        JSON.stringify(noSlot).slice(0, 200),
      )

      // ---- N6：saveId 形状非法（含路径分隔符 / 超长）必须被拒 ----
      const badSlots = ['save/../other', 'save\\other', 's'.repeat(129), '']
      const badResults = badSlots.map((slot) =>
        api.core.handshake({
          runtimeInstanceId: 'rt-probe-badslot',
          launchToken: launchTokenOf('auto'),
          nonce: `nonce-bad-${slot.length}`,
          gameId: 'example.minesweeping',
          gameVersion: '1.0.0',
          sdkVersion: '1.0.0',
          bridgeVersion: 1,
          saveId: slot,
        }),
      )
      record(
        'N6 非法 saveId 形状被拒',
        badResults.every((res) => res.ok === false && res.errorCode === 'PROTOCOL_INVALID'),
        badResults.map((res, i) => `${JSON.stringify(badSlots[i])}->${res.ok}:${res.errorCode}`).join(' | '),
      )

      // ---- N7：跨运行实例恢复（本轮新增覆盖面） ----
      // 上一段已用固定槽位 save-default 写入 revision=1，并在 N4d 封存（state=paused）。
      // 这里在**同一 Host 进程内**按真实顺序走一遍"重开继续"：
      //   实例B 握手 → 同槽位再握手被拒（单存档单控制者）→ 读回 → 接管 → 继续写。
      const hsB = api.core.handshake({
        runtimeInstanceId: 'rt-probe-2',
        launchToken: launchTokenOf('auto'),
        nonce: 'nonce-probe-2',
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-default',
      })
      record(
        'N7a 实例B 以同一 saveId 握手成功且代次自增',
        hsB.ok === true &&
          typeof hsB.runtimeToken === 'string' &&
          hsB.runtimeToken !== token &&
          Number(hsB.generation) > Number(handshake.generation),
        JSON.stringify({ ok: hsB.ok, generation: hsB.generation, prevGeneration: handshake.generation, errorCode: hsB.errorCode }),
      )

      if (hsB.ok === true) {
        // 单存档单控制者：实例B running 期间，再来一个同槽位握手必须被拒（不能暗中顶替）。
        const hsC = api.core.handshake({
          runtimeInstanceId: 'rt-probe-3',
          launchToken: launchTokenOf('auto'),
          nonce: 'nonce-probe-3',
          gameId: 'example.minesweeping',
          gameVersion: '1.0.0',
          sdkVersion: '1.0.0',
          bridgeVersion: 1,
          saveId: 'save-default',
        })
        record(
          'N7b 同槽位已有活跃实例时新握手被拒（STALE_RUNTIME）',
          hsC.ok === false && hsC.errorCode === 'STALE_RUNTIME',
          JSON.stringify(hsC).slice(0, 200),
        )

        const latest = await api.service.saveLatest({ gameId: 'example.minesweeping', saveId: 'save-default' })
        record(
          'N7c 实例B 经 Remote saveLatest 读回上一局',
          latest.ok === true && latest.absent === false && Number(latest.revision) === 2 && latest.elapsedGameMs === 200,
          JSON.stringify(latest).slice(0, 240),
        )

        const resumeWrite = await api.service.saveCheckpoint({
          runtimeToken: hsB.runtimeToken,
          operationId: 'act-probe-2-resume',
          expectedRevision: 2,
          state: { board: 'resumed-by-2' },
          elapsedGameMs: 400,
          rngState: 'seed:resume',
        })
        record(
          'N7d 实例B 从读回的 revision 继续写入',
          resumeWrite.ok === true && Number(resumeWrite.revision) === 3,
          JSON.stringify(resumeWrite).slice(0, 200),
        )

        // 旧实例（已 saveAck 封存）的凭证在任何时候都不得复活写入。
        // 合约要求：拒写；错误码必须是 STALE_RUNTIME（PROTOCOL_INVALID 说明凭证索引被覆盖成"未知"，同样是缺陷）。
        const staleAfterTakeover = await api.service.saveCheckpoint({
          runtimeToken: token,
          operationId: 'act-probe-old-after-takeover',
          expectedRevision: 3,
          state: { board: 'old-takeover' },
          elapsedGameMs: 450,
          rngState: 's',
        })
        record(
          'N7e 已封存的旧实例凭证写入被拒且为 STALE_RUNTIME',
          staleAfterTakeover.ok === false && staleAfterTakeover.errorCode === 'STALE_RUNTIME',
          JSON.stringify(staleAfterTakeover).slice(0, 200),
        )

        const latest2 = await api.service.saveLatest({ gameId: 'example.minesweeping', saveId: 'save-default' })
        record(
          'N7f 再次经 Remote 读回 revision 为 3 且内容是实例B 写的',
          latest2.ok === true &&
            latest2.absent === false &&
            Number(latest2.revision) === 3 &&
            JSON.stringify(latest2.state) === JSON.stringify({ board: 'resumed-by-2' }),
          JSON.stringify(latest2).slice(0, 240),
        )

        // 预览槽位必须隔离：同一 gameId 的 save-preview 不得读到正式槽位内容。
        const previewSlot = await api.service.saveLatest({ gameId: 'example.minesweeping', saveId: 'save-preview' })
        record(
          'N7g 预览槽位 save-preview 与正式槽位隔离',
          previewSlot.ok === true && previewSlot.absent === true,
          JSON.stringify(previewSlot).slice(0, 200),
        )
      } else {
        for (const name of [
          'N7b 同槽位已有活跃实例时新握手被拒（STALE_RUNTIME）',
          'N7c 实例B 经 Remote saveLatest 读回上一局',
          'N7d 实例B 从读回的 revision 继续写入',
          'N7e 已封存的旧实例凭证写入仍被拒',
          'N7f 再次经 Remote 读回 revision 为 3 且内容是实例B 写的',
          'N7g 预览槽位 save-preview 与正式槽位隔离',
        ]) {
          record(name, false, '前置失败：实例B 握手未成功，本条无法成立')
        }
      }
    }
  }

  // ---- N8：全新进程（进程级跨实例）用同一 dataDir/playerId/槽位经 Remote 读回 ----
  // N7 只证明"同进程内两个运行实例"，租约注册表仍在内存里；这条补上
  // "实例A 关闭、进程退出 → 新进程实例B → 经 Remote saveLatest 读到上一局"。
  if (api) {
    const readerScript = `
      const { apply } = await import(process.argv[1])
      const path = await import('node:path')
      const require = (await import('node:module')).createRequire(process.argv[2])
      const { Context } = await import((await import('node:url')).pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
      const api = apply(new Context(), { dataDir: process.argv[3], playerId: 'player-probe-1' })
      const hs = api.core.handshake({
        runtimeInstanceId: 'rt-probe-reader',
        nonce: 'nonce-probe-reader',
        launchToken: 'probe-launch-newproc-hex-0123456789abcdef'.padEnd(43, 'y'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-default',
      })
      // 启动确认：Host 只在**首次业务调用**时把 pending 推进到 running（见
      // GameCenterCore 的 ackDeadline 语义）。新进程若不确认，写入会被当作未确认租约，
      // 这正是生产链路里 Client confirmLaunch 必须做的事，探针照做。
      const confirm = hs.ok === true ? api.service.leaseStatus({ runtimeToken: hs.runtimeToken }) : { absent: true }
      const latest = await api.service.saveLatest({ gameId: 'example.minesweeping', saveId: 'save-default' })
      const write = hs.ok === true
        ? await api.service.saveCheckpoint({
            runtimeToken: hs.runtimeToken,
            operationId: 'act-probe-reader-write',
            expectedRevision: Number(latest.revision) || 0,
            state: { board: 'written-by-new-process' },
            elapsedGameMs: 500,
            rngState: 'seed:newproc',
          })
        : { ok: false, errorCode: 'HANDSHAKE_FAILED' }
      console.log('PROBE_JSON=' + JSON.stringify({ handshakeOk: hs.ok, errorCode: hs.errorCode, latest, write }))
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', readerScript, pathToFileURL(STAGING_INDEX).href, path.join(ROOT, 'packages/dsh-gamecenter/package.json'), dataDir], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    const out = (child.stdout || '').split('PROBE_JSON=')[1] || ''
    let parsed = null
    try {
      parsed = JSON.parse(out.trim())
    } catch {
      /* 保留原始输出 */
    }
    record(
      'N8 新进程实例B 经 Remote 读回上一局并继续写入',
      Boolean(
        parsed &&
          parsed.handshakeOk === true &&
          parsed.latest &&
          parsed.latest.ok === true &&
          parsed.latest.absent === false &&
          Number(parsed.latest.revision) === 3 &&
          parsed.write &&
          parsed.write.ok === true &&
          Number(parsed.write.revision) === 4,
      ),
      parsed
        ? `latest.revision=${parsed.latest && parsed.latest.revision} write.revision=${parsed.write && parsed.write.revision}`
        : `exit=${child.status} stdout=${(child.stdout || '').slice(0, 160)} stderr=${(child.stderr || '').slice(0, 200)}`,
    )
  }

  // ---- N1：相对 dataDir 必须被拒，且 cwd 不得被写入 ----
  const cwdProbe = mkdtemp('dsh-gc-cwd-')
  const before = readdirSync(cwdProbe).length
  let rejected = false
  let detail = ''
  try {
    apply(makeCtx(), { dataDir: 'relative-data-dir', playerId: 'player-probe-1' })
    detail = '未抛错（被接受了）'
  } catch (error) {
    rejected = true
    detail = `已拒绝：${error.message.slice(0, 100)}`
  }
  // 相对路径是否在 cwd 下造出目录：在临时 cwd 里再跑一次，比较文件数
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const { apply } = await import(${JSON.stringify(pathToFileURL(STAGING_INDEX).href)})
      try { apply({ effect: (fn) => fn() }, { dataDir: 'relative-data-dir', playerId: 'p1' }) } catch {}
      const fs = await import('node:fs')
      console.log(JSON.stringify(fs.readdirSync('.')).slice(0, 200))
      `,
    ],
    { cwd: cwdProbe, encoding: 'utf8' },
  )
  const leaked = /relative-data-dir/.test(child.stdout || '')
  record(
    'N1 相对 dataDir 不得落 cwd',
    !leaked && readdirSync(cwdProbe).length === before,
    leaked
      ? `❌ cwd 里出现了 relative-data-dir：相对 dataDir 被 resolve 成 <cwd>/...；apply 抛错原因=${detail}`
      : `cwd 干净；apply 抛错原因=${detail}`,
  )

  // ---- N2：缺 playerId 必须被拒 ----
  let playerRejected = false
  let playerDetail = ''
  try {
    apply(makeCtx(), { dataDir: mkdtemp('dsh-gc-noplayer-') })
    playerDetail = '未抛错（被接受了）'
  } catch (error) {
    playerRejected = true
    playerDetail = `已拒绝：${error.message.slice(0, 100)}`
  }
  record('N2 缺 playerId 被拒', playerRejected, playerDetail)

  // ---- N2b：SQLite 后端直接调用缺身份必须被拒，且库内无写入 ----
  try {
    const backendMod = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-gamecenter/staging/storage/sqlite-save-backend.js')).href)
    const storeMod = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-gamecenter/staging/storage/save-store.js')).href)
    const dbPath = path.join(mkdtemp('dsh-gc-backend-'), 'b.sqlite')
    const backend = new backendMod.SqliteSaveBackend({ dbPath })
    const store = new storeMod.SaveStore(backend)
    let refused = false
    let body = ''
    try {
      const res = await store.writeCheckpoint({
        gameId: 'example.minesweeping',
        saveId: 'save-default',
        operationId: 'act-noident',
        expectedRevision: 0,
        state: { a: 1 },
        elapsedGameMs: 1,
        rngState: 's',
      })
      body = JSON.stringify(res).slice(0, 140)
      refused = res && res.ok === false
    } catch (error) {
      refused = true
      body = `抛错：${error.message.slice(0, 120)}`
    }
    const rows = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite'
      const db = new DatabaseSync(process.argv[1], { readOnly: true })
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gamecenter_saves'").all()
      const n = tables.length === 0 ? 0 : db.prepare('SELECT COUNT(*) AS n FROM gamecenter_saves').get().n
      console.log(JSON.stringify({ n }))
    `, dbPath], { encoding: 'utf8' })
    const noRows = /"n":0/.test(rows.stdout || '')
    record('N2b 后端缺身份被拒且零写入', refused && noRows, `${body}；库内=${(rows.stdout || '').trim()}`)
  } catch (error) {
    record('N2b 后端缺身份被拒且零写入', false, `探针自身失败：${error.message}`)
  }
}

// ——————————————————————————————————————————————————————————————
// N9..N13：生命周期（取消 + 未确认有界回收 + TTL 并存）
//
// 判据来源：PM 2026-10-20 冻结口径。这里全部是**行为断言**：
// 只看"时间推进后 registry / Remote 返回什么"，不靠源码关键词。
// 每条都用自己的 apply() 实例与临时 dataDir，互不污染。
// ——————————————————————————————————————————————————————————————

/** 准备一个独立 Host 实例（真实 apply + 真实 SQLite + 可选 scanIntervalMs）。 */
function freshHost(tag, extra = {}) {
  if (!apply) return null
  const dataDir = mkdtemp(`dsh-gc-${tag}-`)
  try {
    const instance = apply(makeCtx(), {
      dataDir,
      playerId: 'player-probe-1',
      catalogMode: 'fixture',
      ...extra,
    })
    return { api: instance, dataDir }
  } catch (error) {
    record(`${tag} 装配`, false, `apply 抛错：${error.message}`)
    return null
  }
}

if (apply) {
  // ---- N9：无人读写时，pending 租约必须被**定时器**回收 ----
  {
    const host = freshHost('n9')
    if (host) {
      const hs = host.api.core.handshake({
        runtimeInstanceId: 'rt-n9',
        nonce: 'n9',
        launchToken: launchTokenOf('n9'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-default',
      })
      const before = host.api.core.registry
        .all()
        .filter((lease) => lease.runtimeInstanceId === 'rt-n9' && lease.state === 'pending').length

      // **完全不发任何请求**，只等定时器。
      // 硬上界：LEASE_ACK_WINDOW_MS(3000) + 扫描周期(默认 1000) + 余量。
      const started = Date.now()
      await wait(4600)
      const elapsed = Date.now() - started

      const after = host.api.core.registry
        .all()
        .filter((lease) => lease.runtimeInstanceId === 'rt-n9' && lease.state === 'pending').length
      record(
        'N9 无人读写时定时器仍回收 pending 租约（上界 4s+余量）',
        hs.ok === true && before === 1 && after === 0 && elapsed < 6000,
        `握手=${hs.ok} 回收前 pending=${before} 回收后 pending=${after} 等待=${elapsed}ms`,
      )
      host.api.dispose()
    } else {
      record('N9 无人读写时定时器仍回收 pending 租约（上界 4s+余量）', false, '实例装配失败')
    }
  }

  // ---- N10：已确认（running）的租约不得被 T_ack 回收，且 dispose 后停表 ----
  {
    const host = freshHost('n10')
    if (host) {
      const hs = host.api.core.handshake({
        runtimeInstanceId: 'rt-n10',
        nonce: 'n10',
        launchToken: launchTokenOf('n10'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-default',
      })
      // 启动确认（等价于 Client confirmLaunch）
      const confirm = host.api.core.leaseStatus({ runtimeToken: hs.runtimeToken })
      await wait(4600)
      const running = host.api.core.registry
        .all()
        .filter((lease) => lease.runtimeInstanceId === 'rt-n10' && lease.state === 'running').length
      record(
        'N10a 已确认 running 的租约跨过 T_ack 仍存活（不误杀静置玩家）',
        hs.ok === true && confirm && confirm.absent !== true && running === 1,
        `confirm=${JSON.stringify(confirm).slice(0, 80)} running=${running}`,
      )

      // dispose 停表：卸载后再新建一个 pending 握手，推进时间后它仍在（无定时器在跑）。
      host.api.dispose()
      const hs2 = host.api.core.handshake({
        runtimeInstanceId: 'rt-n10b',
        nonce: 'n10b',
        launchToken: launchTokenOf('n10b'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-preview',
      })
      await wait(4600)
      const stillPending = host.api.core.registry
        .all()
        .filter((lease) => lease.runtimeInstanceId === 'rt-n10b' && lease.state === 'pending').length
      record(
        'N10b dispose 后定时器停止（无迟到回收动作）',
        hs2.ok === true && stillPending === 1,
        `dispose 后再次握手=${hs2.ok}，4.6s 后仍 pending=${stillPending}（预期 1=定时器已停）`,
      )
    } else {
      record('N10a 已确认 running 的租约跨过 T_ack 仍存活（不误杀静置玩家）', false, '实例装配失败')
      record('N10b dispose 后定时器停止（无迟到回收动作）', false, '实例装配失败')
    }
  }

  // ---- N11：TTL 过期门禁仍然生效（T_ack 不得替代 TTL） ----
  {
    const host = freshHost('n11', { ttlMs: 1500, scanIntervalMs: 500 })
    if (host) {
      const hs = host.api.core.handshake({
        runtimeInstanceId: 'rt-n11',
        nonce: 'n11',
        launchToken: launchTokenOf('n11'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-default',
      })
      host.api.core.leaseStatus({ runtimeToken: hs.runtimeToken })
      await wait(2200)
      const write = await host.api.service.saveCheckpoint({
        runtimeToken: hs.runtimeToken,
        operationId: 'act-n11',
        expectedRevision: 0,
        state: { board: 'ttl' },
        elapsedGameMs: 1,
        rngState: 's',
      })
      record(
        'N11 租约 TTL 过期后写入被拒为 PAUSED（T_ack 未替代 TTL）',
        write.ok === false && write.errorCode === 'PAUSED',
        JSON.stringify(write).slice(0, 200),
      )
      host.api.dispose()
    } else {
      record('N11 租约 TTL 过期后写入被拒为 PAUSED（T_ack 未替代 TTL）', false, '实例装配失败')
    }
  }

  // ---- N12：abandon 快路径（先到/后到/重复/伪造令牌） ----
  {
    const host = freshHost('n12')
    if (host) {
      // 12a 握手先到，随后 abandon：立即回收，不等 T_ack
      const hsA = host.api.core.handshake({
        runtimeInstanceId: 'rt-n12a',
        nonce: 'n12a',
        launchToken: launchTokenOf('n12a'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-default',
      })
      const abA = await host.api.service.abandonRuntime({
        launchToken: launchTokenOf('n12a'),
        runtimeInstanceId: 'rt-n12a',
      })
      const stillPendingA = host.api.core.registry
        .all()
        .filter((lease) => lease.runtimeInstanceId === 'rt-n12a' && lease.state === 'pending').length
      record(
        'N12a 握手先到 → abandon 立即回收（不等 T_ack）',
        hsA.ok === true && abA.ok === true && abA.abandoned === true && stillPendingA === 0,
        `${JSON.stringify(abA).slice(0, 100)} 残留 pending=${stillPendingA}`,
      )

      // 12b 重复 abandon：幂等，不抛错
      let abRepeat = null
      try {
        abRepeat = await host.api.service.abandonRuntime({
          launchToken: launchTokenOf('n12a'),
          runtimeInstanceId: 'rt-n12a',
        })
      } catch (error) {
        abRepeat = { thrown: error.message }
      }
      record(
        'N12b 重复 abandon 幂等（不抛错）',
        abRepeat && abRepeat.ok === true && abRepeat.reclaimed === false,
        JSON.stringify(abRepeat).slice(0, 140),
      )

      // 12c 伪造 launchToken 撤销别人的实例：必须被拒
      const hsB = host.api.core.handshake({
        runtimeInstanceId: 'rt-n12c',
        nonce: 'n12c',
        launchToken: launchTokenOf('n12c'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-preview',
      })
      const forged = await host.api.service.abandonRuntime({
        launchToken: launchTokenOf('forged'),
        runtimeInstanceId: 'rt-n12c',
      })
      const survived = host.api.core.registry
        .all()
        .filter((lease) => lease.runtimeInstanceId === 'rt-n12c').length
      record(
        'N12c 伪造 launchToken 不得撤销别人的实例（ABANDON_FORBIDDEN）',
        hsB.ok === true && forged.ok === false && forged.errorCode === 'ABANDON_FORBIDDEN' && survived === 1,
        `${JSON.stringify(forged).slice(0, 120)} 目标实例存活=${survived}`,
      )

      // 12d 只给 gameId/saveId 的撤销请求：协议层必须拒（形状不足）
      const slotOnly = await host.api.service.abandonRuntime({
        gameId: 'example.minesweeping',
        saveId: 'save-preview',
      })
      record(
        'N12d 只凭 gameId/saveId 的撤销被拒（PROTOCOL_INVALID）',
        slotOnly.ok === false && slotOnly.errorCode === 'PROTOCOL_INVALID',
        JSON.stringify(slotOnly).slice(0, 160),
      )
      host.api.dispose()
    } else {
      for (const name of [
        'N12a 握手先到 → abandon 立即回收（不等 T_ack）',
        'N12b 重复 abandon 幂等（不抛错）',
        'N12c 伪造 launchToken 不得撤销别人的实例（ABANDON_FORBIDDEN）',
        'N12d 只凭 gameId/saveId 的撤销被拒（PROTOCOL_INVALID）',
      ]) {
        record(name, false, '实例装配失败')
      }
    }
  }

  // ---- N13：快速关闭重开 + 旧凭证拒写 + 全程无 running 孤儿 ----
  {
    const host = freshHost('n13')
    if (host) {
      // 实例A：握手 → 确认 → 写入 → pause → saveAck（正常关闭）
      const hsA = host.api.core.handshake({
        runtimeInstanceId: 'rt-n13a',
        nonce: 'n13a',
        launchToken: launchTokenOf('n13a'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-default',
      })
      host.api.core.leaseStatus({ runtimeToken: hsA.runtimeToken })
      const w1 = await host.api.service.saveCheckpoint({
        runtimeToken: hsA.runtimeToken,
        operationId: 'act-n13a',
        expectedRevision: 0,
        state: { board: 'a' },
        elapsedGameMs: 100,
        rngState: 'r1',
      })
      host.api.service.pause({ runtimeToken: hsA.runtimeToken, reason: 'close' })
      const ack = host.api.service.saveAck({ runtimeToken: hsA.runtimeToken, revision: w1.revision })

      // 实例B：立刻重开，读回上一局并继续写
      const hsB = host.api.core.handshake({
        runtimeInstanceId: 'rt-n13b',
        nonce: 'n13b',
        launchToken: launchTokenOf('n13b'),
        gameId: 'example.minesweeping',
        gameVersion: '1.0.0',
        sdkVersion: '1.0.0',
        bridgeVersion: 1,
        saveId: 'save-default',
      })
      host.api.core.leaseStatus({ runtimeToken: hsB.runtimeToken })
      const latest = await host.api.service.saveLatest({ gameId: 'example.minesweeping', saveId: 'save-default' })
      const w2 = await host.api.service.saveCheckpoint({
        runtimeToken: hsB.runtimeToken,
        operationId: 'act-n13b',
        expectedRevision: latest.revision,
        state: { board: 'b' },
        elapsedGameMs: 200,
        rngState: 'r2',
      })
      record(
        'N13a 快速关闭重开：B 读回 revision 并继续写入成功',
        ack.accepted === true &&
          hsB.ok === true &&
          latest.ok === true &&
          latest.absent === false &&
          w2.ok === true &&
          Number(w2.revision) === Number(w1.revision) + 1,
        `A写入r=${w1.revision} ack=${ack.accepted} B读回r=${latest.revision} B写入r=${w2 && w2.revision}`,
      )

      // 旧实例A 的凭证在 B 接管后不得复活
      const stale = await host.api.service.saveCheckpoint({
        runtimeToken: hsA.runtimeToken,
        operationId: 'act-n13a-late',
        expectedRevision: Number(w2.revision) || 0,
        state: { board: 'a-late' },
        elapsedGameMs: 300,
        rngState: 'r3',
      })
      record(
        'N13b B 接管后旧实例 A 的凭证仍被拒（STALE_RUNTIME）',
        stale.ok === false && stale.errorCode === 'STALE_RUNTIME',
        JSON.stringify(stale).slice(0, 160),
      )

      // 全程结束时不得留下"无人持有"的 running：
      // 这里 B 仍未关闭，属于**有人持有**的 running，允许存在；断言"至多 1 条 running 且属于 B"。
      const runningAll = host.api.core.registry.all().filter((lease) => lease.state === 'running')
      record(
        'N13c 结束时不存在无主 running（至多 1 条且属于当前实例 B）',
        runningAll.length <= 1 &&
          runningAll.every((lease) => lease.runtimeInstanceId === 'rt-n13b') &&
          pendingLeases(host.api.core).length === 0,
        `running=${JSON.stringify(runningAll.map((l) => [l.runtimeInstanceId, l.state]))} pending=${pendingLeases(host.api.core).length}`,
      )
      host.api.dispose()
    } else {
      for (const name of [
        'N13a 快速关闭重开：B 读回 revision 并继续写入成功',
        'N13b B 接管后旧实例 A 的凭证仍被拒（STALE_RUNTIME）',
        'N13c 结束时不存在无主 running（至多 1 条且属于当前实例 B）',
      ]) {
        record(name, false, '实例装配失败')
      }
    }
  }
}

for (const dir of dirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

const failed = results.filter((result) => !result.ok)
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, evidence: 'MOCK/BUILD（本机 Node + staging 产物，非 DSH-REAL）', results }, null, 2))
} else {
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`)
    console.log(`        ${result.detail}`)
  }
  console.log('')
  console.log(`合计 ${results.length} 项，失败 ${failed.length} 项（证据分栏：MOCK/BUILD，非 DSH-REAL）`)
}
process.exit(failed.length === 0 ? 0 : 1)
