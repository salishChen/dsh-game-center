// @ts-check
/**
 * DSH 内游戏中心主弹层（基线 §4/§5/§7、阶段1 生产接线完成版）。
 *
 * 核心功能与生产接线闭环：
 * 1. 发现与已安装游戏列表：通过 Host Remote `catalogList` 加载，展示审批状态与已安装标记；
 *    source: 'fixture' 时显式展示“本地预览，非 GitHub 上架”告警，且对未审批版本禁用安装。
 * 2. 远端安全安装：通过 Host Remote `catalogInstall` 校验五元组并完成 commit 隔离安装，
 *    原样回显错误码与进度。
 * 3. 本地受控独立预览：通过 Host Remote `previewList` 与 `previewBundle` 独立加载，
 *    不编造假 commit 或审批记录，明示“本地预览（未上架）”，不走安装门禁。
 * 4. 受限沙箱 iframe 启动：通过 Host Remote 获取文本资源，组装安全文档：
 *    - 严格强制 `sandbox="allow-scripts"`（绝不含 allow-same-origin）；
 *    - 写入强 CSP 策略断网（GAME_DOCUMENT_CSP）；
 *    - 全部外部脚本与样式强制内联化，严禁 http(s): 绝对外链；
 *    - 先行注入 SDK 引导，支持 `srcdoc` 与 `blob:` 双路径切换运行。
 * 5. 专用 MessagePort Bridge 双向通信：
 *    - 握手鉴权：`event.source === iframe.contentWindow` + 一次性 nonce + runtimeInstanceId；
 *    - 端口安全传递：`channel.port2` 投递至沙箱，宿主侧由 BridgeDispatcher 负责白名单管控；
 *    - 真实检查点写入：`onCheckpoint` 调 Host Remote `saveCheckpoint`，出示内存 `runtimeToken`，
 *      不伪造 revision，不硬编码 `playerId`；
 *    - 顺序收敛：`triggerPause` -> 最终检查点落盘 -> `saveAck` 封存 -> 销毁运行时；写盘失败不显示已保存。
 * 6. 保留链路诊断区（RemoteDiagnostics），供随时检测。
 */

// @ts-expect-error 运行时由 DSH 浏览器静态外部表提供
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import { captureFocusReturn, pushEscapeLayer } from './focus.js';
import { RemoteDiagnostics } from './RemoteDiagnostics.js';
import {
  assembleGameDocument,
  GAME_IFRAME_SANDBOX,
} from '../runtime/assembler.js';
import { verifyHandshake, createNonce, createLaunchToken } from '../bridge/host-bridge.js';
import { createBridgeDispatcher } from '../bridge/dispatcher.js';
import { openInput } from '../runtime/lease.js';

/**
 * @typedef {object} OverlayStore
 * @property {boolean} open
 * @property {(next: boolean) => void} set
 * @property {(fn: (open: boolean) => void) => () => void} subscribe
 */

/**
 * @typedef {{kind: string, message: string}} PauseResult
 */

/**
 * 存档槽位（saveId）由架构与协议负责人在 protocol `SAVE_SLOTS` 冻结：
 * - 正式安装的游戏固定 `save-default`（"继续游戏"按同一槽位读回上一局）；
 * - 本地受控预览固定 `save-preview`，与正式存档隔离。
 * **握手、beginRuntime、saveLatest 必须使用同一个值**，否则 Host 侧租约的 saveId
 * 与 Client 查询槽位不一致，"关闭保存→重开恢复"结构上不成立。
 */
const SAVE_ID_DEFAULT = 'save-default';
const SAVE_ID_PREVIEW = 'save-preview';

/**
 * @typedef {object} CatalogEntry
 * @property {string} gameId
 * @property {string} title
 * @property {string} summary
 * @property {string} version
 * @property {string} repository
 * @property {string} commit
 * @property {string} manifestDigest
 * @property {string} bundleDigest
 * @property {'approved' | 'pending' | 'rejected' | 'unknown'} approvalState
 * @property {boolean} installed
 * @property {string | null} installedCommit
 */

/**
 * @typedef {object} PreviewEntry
 * @property {string} previewId
 * @property {string} gameId
 * @property {string} name
 * @property {string} version
 * @property {'fixture'} source
 * @property {string} label
 * @property {boolean} installable
 */

/**
 * 游戏中心主弹层组件。
 *
 * @param {object} props
 * @param {OverlayStore} props.overlay
 * @param {(key: string) => string} props.t
 * @param {(reason: string) => Promise<PauseResult>} props.requestPause
 * @param {((args: { gameId: string, saveId: string, runtimeInstanceId?: string }) => any) | null} [props.beginRuntime]
 * @param {((ack: { generation: number, revision: number }) => void) | null} [props.onSaveAck]
 * @param {() => void} props.onClosed
 * @param {{ failure: string | null, mounted: boolean }} [props.remoteState]
 * @param {() => any} [props.getService]
 * @param {() => string} [props.makeNonce]
 * @param {() => string} [props.makeLaunchToken]
 * @param {any} [props.runDiagnostics]
 */
export function GameCenterOverlay({
  overlay,
  t,
  requestPause,
  beginRuntime = null,
  onSaveAck = null,
  onClosed,
  remoteState = { failure: null, mounted: false },
  getService = () => null,
  makeNonce = () => '',
  makeLaunchToken = () => '',
  runDiagnostics = null,
}) {
  const [open, setOpen] = useState(overlay.open);
  const [activeTab, setActiveTab] = useState(/** @type {'games' | 'diagnostics'} */ ('games'));
  const [phase, setPhase] = useState(/** @type {'idle' | 'pausing' | 'paused' | 'recovery'} */ ('idle'));
  const [notice, setNotice] = useState(/** @type {string | null} */ (null));
  const [frameMode, setFrameMode] = useState(/** @type {'srcdoc' | 'blob'} */ ('srcdoc'));

  // 目录列表与预览状态
  const [catalogSource, setCatalogSource] = useState(/** @type {string | null} */ (null));
  const [catalogEntries, setCatalogEntries] = useState(/** @type {CatalogEntry[]} */ ([]));
  const [previewEntries, setPreviewEntries] = useState(/** @type {PreviewEntry[]} */ ([]));
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(/** @type {string | null} */ (null));
  const [installingGameId, setInstallingGameId] = useState(/** @type {string | null} */ (null));
  const [installError, setInstallError] = useState(/** @type {string | null} */ (null));

  // 当前运行中的游戏会话
  const [runningSession, setRunningSession] = useState(/** @type {any | null} */ (null));

  const dialogRef = useRef(/** @type {any} */ (null));
  const iframeRef = useRef(/** @type {HTMLIFrameElement | null} */ (null));
  const busy = useRef(false);
  /** @type {{current: (() => void) | null}} */
  const restoreFocus = useRef(null);

  /**
   * 放弃一次启动（协议 2026-10-20 冻结的第 13 条 Remote 方法 `abandonRuntime`）。
   *
   * 【为什么必须有它】Host 侧 `acquire()` 对"已封存槽位"一律允许接管，无法区分
   * "合法重开继续"与"Client 已 abort 的迟到握手"。迟到握手一旦 `markRunning`，
   * 槽位上就留下一个系统里无人持有的孤儿 running 租约（PM 点名的本地生命周期阻断）。
   * 本调用让 Host 立即回收该启动，不必等满 `LEASE_ACK_WINDOW_MS`（3s）。
   *
   * 纪律：
   * - 入参只含 `launchToken` + `runtimeInstanceId`（Host 用两者交叉校验调用者身份，
   *   不接受只凭 gameId/saveId 撤销别人的实例）；
   * - `launchToken` 只在 Bridge 内存持有，不进 iframe、不进日志、不进 UI 文案；
   * - 重复调用必须安全（Host 侧幂等），失败只 warn，**绝不**阻塞关闭路径。
   *
   * @param {{launchToken?: string | null, runtimeInstanceId?: string | null}} session
   * @returns {Promise<void>}
   */
  const abandonLaunch = useCallback(
    /** @type {(session: {launchToken?: string | null, runtimeInstanceId?: string | null} | null) => Promise<void>} */
    async (session) => {
      if (!session) return;
      const launchToken = typeof session.launchToken === 'string' ? session.launchToken : '';
      const runtimeInstanceId = typeof session.runtimeInstanceId === 'string' ? session.runtimeInstanceId : '';
      if (launchToken === '' || runtimeInstanceId === '') return;
      try {
        const service = getService();
        if (!service || typeof service.abandonRuntime !== 'function') return;
        await service.abandonRuntime({ launchToken, runtimeInstanceId });
      } catch (err) {
        // 失败不得阻塞关闭；只在控制台留痕，不把令牌写进任何消息。
        console.warn('[GameCenterOverlay] abandonRuntime 调用失败（不影响关闭）');
      }
    },
    [getService],
  );

  useEffect(() => overlay.subscribe(setOpen), [overlay]);

  /**
   * 启动后主动确认一次，让 Host 把 `pending` 租约推进为 `running`。
   *
   * 【为什么不能只 warn】协议 `LEASE_ACK_WINDOW_MS`（3s）只覆盖"租约已创建但
   * 尚未被客户端确认"的阶段。若确认失败而不上报，界面会显示"在跑"，但 Host 侧
   * 租约仍是 pending，3 秒后被回收——**界面在跑、存档全是 STALE_RUNTIME**。
   * 所以这里必须如实返回结果，由调用方决定是否走补偿路径。
   *
   * @param {{gameId: string, saveId: string, runtimeToken: string | null}} args
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
   */
  const confirmLaunch = useCallback(
    /** @type {(args: {gameId: string, saveId: string, runtimeToken: string | null}) => Promise<{ok: true} | {ok: false, code: string, message: string}>} */
    async ({ gameId, saveId, runtimeToken }) => {
      if (typeof runtimeToken !== 'string' || runtimeToken === '') {
        return { ok: false, code: 'CREDENTIAL_MISSING', message: '未拿到运行凭证，无法向 Host 确认' };
      }
      try {
        const service = getService();
        if (!service || typeof service.leaseStatus !== 'function') {
          return { ok: false, code: 'MOUNT_INVALID_CONTRIBUTION', message: 'Host leaseStatus 服务未就绪' };
        }
        const res = await service.leaseStatus({ runtimeToken, gameId, saveId });
        // Host 对无效凭证统一回 absent:true（不区分原因，避免探测）。
        // absent 意味着这个启动没有对应的活跃租约——必须当成确认失败，不能放行。
        if (res && res.absent === true) {
          return { ok: false, code: 'LEASE_ABSENT', message: 'Host 侧没有本次运行的活跃租约' };
        }
        return { ok: true };
      } catch (err) {
        const e = /** @type {any} */ (err);
        return { ok: false, code: e?.code || 'UNKNOWN', message: e?.message || '启动确认失败' };
      }
    },
    [getService],
  );

  /**
   * 启动失败后的完整补偿：放弃 Host 租约、销毁 iframe/ports/blob、清空会话。
   *
   * 与 `close()` 的区别：这里不进入暂停流程（游戏从未真正开始跑），
   * 只需要把已创建的资源全部撤掉，并把失败原因如实告诉玩家。
   *
   * @param {any} session 已部分初始化的运行会话
   * @param {string} notice 展示给玩家的失败原因
   * @returns {Promise<void>}
   */
  const rollbackLaunch = useCallback(
    /** @type {(session: any, notice: string) => Promise<void>} */
    async (session, notice) => {
      if (session?.dispatcher && typeof session.dispatcher.dispose === 'function') {
        session.dispatcher.dispose();
      }
      if (session?.blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(session.blobUrl);
      }
      await abandonLaunch(session);
      setRunningSession(null);
      setNotice(notice);
      setPhase('idle');
    },
    [abandonLaunch],
  );

  // 加载远端目录列表与受控预览列表
  const loadCatalog = useCallback(
    async (refresh = false) => {
      const service = getService();
      if (!service || typeof service.catalogList !== 'function') {
        return;
      }
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const res = await service.catalogList({ refresh });
        if (res && res.ok === true) {
          setCatalogSource(res.source);
          setCatalogEntries(res.entries || []);
        } else {
          setCatalogError(res?.message || '获取游戏目录失败');
        }

        if (typeof service.previewList === 'function') {
          try {
            const pRes = await service.previewList();
            if (pRes && pRes.ok && pRes.configured && Array.isArray(pRes.entries)) {
              setPreviewEntries(pRes.entries);
            }
          } catch {}
        }
      } catch (err) {
        const e = /** @type {any} */ (err);
        setCatalogError(e.message || '获取游戏目录异常');
      } finally {
        setCatalogLoading(false);
      }
    },
    [getService],
  );

  // 弹层打开时自动拉取目录
  useEffect(() => {
    if (open && catalogEntries.length === 0 && !runningSession) {
      void loadCatalog(false);
    }
  }, [open, catalogEntries.length, runningSession, loadCatalog]);

  /**
   * 唯一关闭收敛点：暂停游戏、结算代次、清空会话与资源。
   * @param {string} reason
   * @returns {Promise<void>}
   */
  const close = useCallback(
    /** @type {(reason: string) => Promise<void>} */
    async (reason) => {
      if (busy.current) return;
      busy.current = true;
      setPhase('pausing');
      try {
        if (runningSession?.dispatcher) {
          runningSession.dispatcher.triggerPause({ reason });
        }
        const outcome = await requestPause(reason);
        setNotice(outcome.message);
        setPhase(outcome.kind === 'saved' ? 'paused' : 'recovery');

        if (runningSession?.blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(runningSession.blobUrl);
        }
        if (runningSession?.dispatcher) {
          runningSession.dispatcher.dispose();
        }
        // 【放弃启动】关闭路径统一通知 Host 撤销本次启动。
        // 已正常保存的场景下 Host 侧应幂等返回（reclaimed:false）；若 pause 超时/崩溃，
        // 这一步能把"未确认/无人持有"的租约立刻回收，不等 3s 窗口。
        await abandonLaunch(runningSession);
        setRunningSession(null);
      } finally {
        busy.current = false;
        // 如果是在游戏运行时点击“返回列表”，不关闭整个弹层，仅退出游戏
        if (reason === 'close' || reason === 'escape' || !runningSession) {
          onClosed();
          overlay.set(false);
        }
      }
    },
    [requestPause, onClosed, overlay, runningSession, abandonLaunch],
  );

  // 安装游戏
  const handleInstall = async (/** @type {CatalogEntry} */ entry) => {
    if (entry.approvalState !== 'approved') return;
    setInstallingGameId(entry.gameId);
    setInstallError(null);
    try {
      const service = getService();
      if (!service || typeof service.catalogInstall !== 'function') {
        throw new Error('Remote catalogInstall 服务未就绪');
      }
      const res = await service.catalogInstall({
        gameId: entry.gameId,
        commit: entry.commit,
        manifestDigest: entry.manifestDigest,
        bundleDigest: entry.bundleDigest,
      });
      if (res && res.ok === true) {
        setCatalogEntries((/** @type {CatalogEntry[]} */ prev) =>
          prev.map((e) => (e.gameId === entry.gameId ? { ...e, installed: true, installedCommit: entry.commit } : e)),
        );
      } else {
        setInstallError(`${res?.errorCode || 'INSTALL_FAILED'}: ${res?.message || '安装失败'}`);
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      setInstallError(e.message || '安装调用失败');
    } finally {
      setInstallingGameId(null);
    }
  };

  // 启动 / 继续正式安装的游戏
  const handleLaunchGame = async (/** @type {CatalogEntry} */ entry, isResume = false) => {
    setNotice(null);
    try {
      const service = getService();
      if (!service || typeof service.gameBundle !== 'function') {
        throw new Error('Remote gameBundle 服务未就绪');
      }

      // 【存档槽位契约】正式安装的游戏固定使用 SAVE_ID_DEFAULT。
      // 握手下发后 Host 侧同一 gameId+saveId 已有活跃租约时返回 SAVE_LEASE_BUSY，非新错误码。
      const saveId = SAVE_ID_DEFAULT;

      let initialElapsedMs = 0;
      let initialRngState = '';
      let initialRevision = 0;

      if (isResume && typeof service.saveLatest === 'function') {
        const saveRes = await service.saveLatest({ gameId: entry.gameId, saveId });
        if (saveRes && saveRes.ok === true) {
          if (saveRes.absent === false) {
            if (saveRes.installedCommit && saveRes.installedCommit !== entry.commit) {
              setNotice(`存档固定提交 (${saveRes.installedCommit.slice(0, 7)}) 与当前安装版本不匹配，开启新局`);
            } else {
              initialElapsedMs = Number(saveRes.elapsedGameMs) || 0;
              initialRngState = String(saveRes.rngState || '');
              initialRevision = Number(saveRes.revision) || 0;
            }
          } else {
            setNotice('未找到历史检查点，开启全新对局');
          }
        }
      }

      const bundleRes = await service.gameBundle({ gameId: entry.gameId, commit: entry.commit });
      if (!bundleRes || bundleRes.ok !== true) {
        throw new Error(bundleRes?.message || '获取游戏资源失败');
      }

      const runtimeInstanceId = 'rt-' + Math.random().toString(36).slice(2, 10);
      // nonce 是 iframe 握手配对的一次性凭证依据，**不得**用可猜值兜底：
      // makeNonce 内部就是 createNonce（无 CSPRNG 会抛错），这里不再另设 Math.random 回退。
      const nonce = typeof makeNonce === 'function' && makeNonce() ? makeNonce() : createNonce();
      // 启动令牌：只在 Bridge 内存持有，用于 abort/关闭/启动失败时 abandonRuntime。
      // 与 nonce 同代生成，但**用途不同**：nonce 给 iframe 握手，launchToken 给 Host 撤销。
      const launchToken = typeof makeLaunchToken === 'function' && makeLaunchToken() ? makeLaunchToken() : createLaunchToken();

      let runtimeToken = null;
      let hostGen = 1;
      if (typeof service.handshake === 'function') {
        const hsRes = await service.handshake({
          runtimeInstanceId,
          nonce,
          gameId: entry.gameId,
          gameVersion: entry.version || '1.0.0',
          sdkVersion: '1.0.0',
          bridgeVersion: 1,
          // 存档槽位必须与 beginRuntime / saveLatest 完全一致，否则 Host 按运行实例 ID
          // 另起一个租约，续玩永远读不到本局的检查点。
          saveId,
          // 协议必填：abandonRuntime 用它证明"我就是这个启动的发起者"。
          launchToken,
        });
        if (hsRes && hsRes.ok === true) {
          runtimeToken = hsRes.runtimeToken;
          hostGen = hsRes.generation || 1;
        } else {
          // 握手被拒：立即放弃这次启动，避免 Host 侧留下未确认/无人持有的租约。
          await abandonLaunch({ launchToken, runtimeInstanceId });
          throw new Error(hsRes?.message || 'Host 握手授权失败');
        }
      }

      const lease =
        typeof beginRuntime === 'function' ? beginRuntime({ gameId: entry.gameId, saveId, runtimeInstanceId }) : null;
      if (!lease) {
        await abandonLaunch({ launchToken, runtimeInstanceId });
        throw new Error('创建运行租约失败');
      }
      lease.nonce = nonce;
      lease.runtimeInstanceId = runtimeInstanceId;
      lease.generation = hostGen;

      // 【时序硬约束】先向 Host 确认运行状态，**成功之后**才组装并投递 iframe 端口。
      // 顺序不能反：若先放 iframe 再确认，游戏可能已经发出 save.checkpoint / ai.generate，
      // 而此时 Host 侧租约仍是 pending（甚至已被 T_ack 回收）——业务请求全部 STALE_RUNTIME，
      // 玩家看到的是"能点但存不上"。确认失败则走完整补偿，绝不留着界面显示在跑。
      const confirm = await confirmLaunch({ gameId: entry.gameId, saveId, runtimeToken });
      if (!confirm.ok) {
        await abandonLaunch({ launchToken, runtimeInstanceId });
        throw new Error(`启动失败：未能与 Host 确认运行状态 (${confirm.code})，请重试`);
      }

      const docHtml = assembleGameDocument({
        entryPath: bundleRes.entryPath || 'dist/index.html',
        files: bundleRes.files || [],
        options: {
          runtimeInstanceId,
          nonce,
          initialSeed: entry.gameId === 'example.minesweeping' ? 424242 : 1,
          initialRngState,
          initialElapsedMs,
          initialRevision,
        },
      });

      let blobUrl = null;
      if (frameMode === 'blob' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
        const blob = new Blob([docHtml], { type: 'text/html' });
        blobUrl = URL.createObjectURL(blob);
      }

      setRunningSession({
        gameId: entry.gameId,
        commit: entry.commit,
        title: entry.title,
        runtimeInstanceId,
        nonce,
        launchToken,
        runtimeToken,
        lease,
        docHtml,
        blobUrl,
        dispatcher: null,
      });
      setPhase('idle');
    } catch (err) {
      const e = /** @type {any} */ (err);
      setNotice(`启动游戏失败: ${e.message}`);
    }
  };

  // 启动本地受控预览（独立路径，不走 catalogInstall）
  const handleLaunchPreview = async (/** @type {PreviewEntry} */ previewEntry) => {
    setNotice(null);
    try {
      const service = getService();
      if (!service || typeof service.previewBundle !== 'function') {
        throw new Error('Remote previewBundle 服务未就绪');
      }
      const bundleRes = await service.previewBundle({ previewId: previewEntry.previewId });
      if (!bundleRes || bundleRes.ok !== true) {
        throw new Error(bundleRes?.message || '获取预览资源失败');
      }

      const runtimeInstanceId = 'rt-prev-' + Math.random().toString(36).slice(2, 10);
      // 与正式启动同口径：nonce 不设可猜兜底
      const nonce = typeof makeNonce === 'function' && makeNonce() ? makeNonce() : createNonce();
      // 预览同样需要 launchToken：预览握手也会在 Host 创建租约，abort 后同样要能撤销。
      const launchToken =
        typeof makeLaunchToken === 'function' && makeLaunchToken() ? makeLaunchToken() : createLaunchToken();

      let runtimeToken = null;
      let hostGen = 1;
      if (typeof service.handshake === 'function') {
        const hsRes = await service.handshake({
          runtimeInstanceId,
          nonce,
          gameId: previewEntry.gameId,
          gameVersion: previewEntry.version || '1.0.0',
          sdkVersion: '1.0.0',
          bridgeVersion: 1,
          saveId: SAVE_ID_PREVIEW,
          launchToken,
        });
        if (hsRes && hsRes.ok === true) {
          runtimeToken = hsRes.runtimeToken;
          hostGen = hsRes.generation || 1;
        } else {
          // 预览握手被拒同样立即放弃，避免 save-preview 槽位留下孤儿租约。
          await abandonLaunch({ launchToken, runtimeInstanceId });
          throw new Error(hsRes?.message || 'Host 预览握手授权失败');
        }
      }

      const lease =
        typeof beginRuntime === 'function'
          ? beginRuntime({ gameId: previewEntry.gameId, saveId: SAVE_ID_PREVIEW, runtimeInstanceId })
          : null;
      if (!lease) {
        await abandonLaunch({ launchToken, runtimeInstanceId });
        throw new Error('创建预览运行租约失败');
      }
      lease.nonce = nonce;
      lease.runtimeInstanceId = runtimeInstanceId;
      lease.generation = hostGen;

      // 与正式启动同一时序硬约束：先确认、后放 iframe 端口。
      const confirm = await confirmLaunch({
        gameId: previewEntry.gameId,
        saveId: SAVE_ID_PREVIEW,
        runtimeToken,
      });
      if (!confirm.ok) {
        await abandonLaunch({ launchToken, runtimeInstanceId });
        throw new Error(`启动预览失败：未能与 Host 确认运行状态 (${confirm.code})，请重试`);
      }

      const docHtml = assembleGameDocument({
        entryPath: bundleRes.entryPath || 'dist/index.html',
        files: bundleRes.files || [],
        options: {
          runtimeInstanceId,
          nonce,
          initialSeed: 424242,
          initialElapsedMs: 0,
          initialRevision: 0,
        },
      });

      let blobUrl = null;
      if (frameMode === 'blob' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
        const blob = new Blob([docHtml], { type: 'text/html' });
        blobUrl = URL.createObjectURL(blob);
      }

      setRunningSession({
        gameId: previewEntry.gameId,
        commit: 'preview',
        title: `${previewEntry.name}（${previewEntry.label || '本地预览'}）`,
        runtimeInstanceId,
        nonce,
        launchToken,
        runtimeToken,
        lease,
        docHtml,
        blobUrl,
        dispatcher: null,
      });
      setPhase('idle');
    } catch (err) {
      const e = /** @type {any} */ (err);
      setNotice(`启动预览失败: ${e.message}`);
    }
  };

  // 监听 iframe 握手消息并绑定 MessagePort
  useEffect(() => {
    if (!runningSession) return undefined;

    const onWindowMessage = (/** @type {MessageEvent} */ event) => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return;

      const verified = verifyHandshake({
        data: event.data,
        source: event.source,
        expected: {
          window: iframeWin,
          runtimeInstanceId: runningSession.runtimeInstanceId,
          nonce: runningSession.nonce,
          generation: runningSession.lease ? runningSession.lease.generation : 1,
        },
      });

      if (!verified.ok) {
        console.warn('[GameCenterOverlay] 沙箱握手校验未通过:', verified.message);
        return;
      }

      if (!runningSession.lease) {
        console.warn('[GameCenterOverlay] 运行租约未初始化，拒绝建立通信');
        return;
      }

      openInput(runningSession.lease);

      const channel = new MessageChannel();

      const dispatcher = createBridgeDispatcher({
        lease: runningSession.lease,
        port: channel.port1,
        onCheckpoint: async (input) => {
          const service = getService();
          if (!service || typeof service.saveCheckpoint !== 'function') {
            throw new Error('Host saveCheckpoint 服务未就绪');
          }
          if (!runningSession.runtimeToken) {
            throw new Error('未持有有效运行凭证 runtimeToken');
          }
          const res = await service.saveCheckpoint({
            runtimeToken: runningSession.runtimeToken,
            operationId: input.operationId,
            expectedRevision: input.expectedRevision,
            state: input.state,
            elapsedGameMs: input.elapsedGameMs,
            rngState: input.rngState,
            generation: runningSession.lease.generation,
          });
          if (!res || res.ok !== true) {
            const err = new Error(res?.message || '保存检查点失败');
            /** @type {any} */ (err).code = res?.errorCode || 'INTERNAL';
            /** @type {any} */ (err).retryable = Boolean(res?.retryable);
            /** @type {any} */ (err).currentRevision = res?.currentRevision;
            throw err;
          }
          return {
            revision: res.revision,
            idempotentReplay: Boolean(res.idempotentReplay),
          };
        },
        onPauseAck: async (payload) => {
          const service = getService();
          if (service && typeof service.saveAck === 'function' && runningSession.runtimeToken) {
            try {
              await service.saveAck({
                runtimeToken: runningSession.runtimeToken,
                revision: payload.revision || 1,
                generation: payload.generation,
              });
            } catch (ackErr) {
              console.error('[GameCenterOverlay] saveAck 调用失败:', ackErr);
            }
          }
          if (typeof onSaveAck === 'function' && runningSession.lease) {
            onSaveAck({ generation: payload.generation, revision: payload.revision || 1 });
          }
        },
      });

      runningSession.dispatcher = dispatcher;

      // 向沙箱 iframe 投递专用 MessagePort
      iframeWin.postMessage({ type: 'dsh-gamecenter:port', nonce: runningSession.nonce }, '*', [channel.port2]);
    };

    window.addEventListener('message', onWindowMessage);
    return () => {
      window.removeEventListener('message', onWindowMessage);
    };
  }, [runningSession, onSaveAck, getService]);

  // 打开弹层焦点管理与 Escape 监听
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    restoreFocus.current = captureFocusReturn(dialog);
    if (dialog !== null && typeof dialog.focus === 'function') dialog.focus();
    const pop = pushEscapeLayer(() => {
      void close('escape');
    });

    return () => {
      pop();
      const restore = restoreFocus.current;
      restoreFocus.current = null;
      if (restore !== null) restore();
    };
  }, [open, close]);

  if (!open) return null;

  const title = t('title');

  return h(
    'div',
    { 'data-gamecenter-overlay': '' },
    h('div', {
      'data-gamecenter-mask': '',
      'aria-hidden': 'true',
      onClick: () => void close('close'),
      style: MASK_STYLE,
    }),
    h(
      'div',
      {
        ref: dialogRef,
        tabIndex: -1,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        'aria-busy': phase === 'pausing' ? 'true' : 'false',
        'data-gamecenter-dialog': '',
        'data-gamecenter-phase': phase,
        style: runningSession ? RUNNING_DIALOG_STYLE : DIALOG_STYLE,
      },
      // 头部标题与 Tab 切换
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
        h('h2', { id: 'gamecenter-title', style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, title),
        !runningSession &&
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            h(
              'button',
              {
                type: 'button',
                'data-gamecenter-tab': 'games',
                onClick: () => setActiveTab('games'),
                style: activeTab === 'games' ? ACTIVE_TAB_STYLE : TAB_STYLE,
              },
              '游戏库',
            ),
            h(
              'button',
              {
                type: 'button',
                'data-gamecenter-tab': 'diagnostics',
                onClick: () => setActiveTab('diagnostics'),
                style: activeTab === 'diagnostics' ? ACTIVE_TAB_STYLE : TAB_STYLE,
              },
              '链路诊断',
            ),
          ),
      ),

      phase === 'pausing' ? h('p', { 'aria-live': 'polite', style: { margin: '0 0 12px', color: '#0969da' } }, t('pausing')) : null,
      notice !== null ? h('p', { role: 'status', style: { margin: '0 0 12px', color: '#1a7f37' } }, notice) : null,

      // 1. 运行中模式：受控 iframe 界面
      runningSession !== null &&
        h(
          'div',
          { 'data-gamecenter-game-active': '', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--dsw-alias-bg-subtle, #f6f8fa)',
                borderRadius: '8px',
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('span', { style: { fontWeight: 600 } }, runningSession.title),
              h('span', { style: { fontSize: '12px', color: '#57606a' } }, `commit: ${runningSession.commit.slice(0, 7)}`),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setFrameMode(frameMode === 'srcdoc' ? 'blob' : 'srcdoc'),
                  style: { ...BUTTON_STYLE, fontSize: '12px', padding: '3px 8px' },
                },
                `模式: ${frameMode}`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-gamecenter-action': 'back-to-list',
                  onClick: () => void close('back-to-list'),
                  disabled: phase === 'pausing',
                  style: BUTTON_STYLE,
                },
                '暂停并返回',
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-gamecenter-action': 'close',
                  onClick: () => void close('close'),
                  disabled: phase === 'pausing',
                  style: BUTTON_STYLE,
                },
                '关闭',
              ),
            ),
          ),
          h('iframe', {
            ref: iframeRef,
            'data-gamecenter-frame': '',
            sandbox: GAME_IFRAME_SANDBOX,
            srcdoc: frameMode === 'srcdoc' ? runningSession.docHtml : undefined,
            src: frameMode === 'blob' ? runningSession.blobUrl : undefined,
            style: {
              width: '100%',
              height: '520px',
              border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
              borderRadius: '8px',
              background: '#fff',
            },
          }),
        ),

      // 2. 游戏库列表 Tab（仅在无运行游戏时可见）
      !runningSession &&
        activeTab === 'games' &&
        h(
          'div',
          { 'data-gamecenter-catalog': '', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          catalogSource === 'fixture' &&
            h(
              'div',
              {
                'data-gamecenter-badge': 'fixture',
                style: {
                  background: '#fff8c5',
                  color: '#9a6700',
                  border: '1px solid rgba(212, 167, 44, 0.4)',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  fontSize: '13px',
                },
              },
              '⚠️ 本地预览模式（条目来自本地 fixture，非 GitHub 真实上架；未审批版本不可安装）。',
            ),

          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', { style: { fontSize: '14px', color: 'var(--dsw-alias-label-secondary)' } }, `共发现 ${catalogEntries.length} 款小游戏`),
            h(
              'button',
              {
                type: 'button',
                onClick: () => void loadCatalog(true),
                disabled: catalogLoading,
                style: { ...BUTTON_STYLE, fontSize: '12px', padding: '4px 10px' },
              },
              catalogLoading ? '正在刷新…' : '刷新目录',
            ),
          ),

          catalogError !== null && h('div', { role: 'alert', style: { color: '#cf222e', fontSize: '13px' } }, catalogError),
          installError !== null && h('div', { role: 'alert', style: { color: '#cf222e', fontSize: '13px' } }, installError),

          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            catalogEntries.map((/** @type {CatalogEntry} */ entry) =>
              h(
                'div',
                {
                  key: entry.gameId,
                  'data-gamecenter-card': entry.gameId,
                  style: {
                    padding: '12px',
                    border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
                    borderRadius: '8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
                  h('span', { style: { fontWeight: 600, fontSize: '15px' } }, `${entry.title} v${entry.version}`),
                  h(
                    'span',
                    {
                      style: {
                        fontSize: '12px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        background: entry.approvalState === 'approved' ? '#dafbe1' : '#ffebe9',
                        color: entry.approvalState === 'approved' ? '#1a7f37' : '#cf222e',
                      },
                    },
                    entry.approvalState === 'approved' ? '已审批' : `未审批 (${entry.approvalState})`,
                  ),
                ),
                h('p', { style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, entry.summary),
                h(
                  'div',
                  { style: { fontSize: '12px', color: '#57606a', display: 'flex', gap: '12px' } },
                  h('span', null, `ID: ${entry.gameId}`),
                  h('span', null, `Commit: ${entry.commit.slice(0, 7)}`),
                ),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' } },
                  !entry.installed
                    ? h(
                        'button',
                        {
                          type: 'button',
                          'data-gamecenter-action': 'install',
                          disabled: entry.approvalState !== 'approved' || installingGameId === entry.gameId,
                          onClick: () => void handleInstall(entry),
                          style: {
                            ...BUTTON_STYLE,
                            background: entry.approvalState === 'approved' ? 'var(--dsw-alias-accent, #0969da)' : '#f6f8fa',
                            color: entry.approvalState === 'approved' ? '#fff' : '#8c959f',
                            border: 'none',
                          },
                        },
                        installingGameId === entry.gameId
                          ? '正在安装…'
                          : entry.approvalState !== 'approved'
                            ? '未审批不可安装'
                            : '安全安装',
                      )
                    : h(
                        'div',
                        { style: { display: 'flex', gap: '8px' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            'data-gamecenter-action': 'launch',
                            onClick: () => void handleLaunchGame(entry, false),
                            style: { ...BUTTON_STYLE, background: 'var(--dsw-alias-accent, #0969da)', color: '#fff', border: 'none' },
                          },
                          '开始新游戏',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            'data-gamecenter-action': 'resume',
                            onClick: () => void handleLaunchGame(entry, true),
                            style: BUTTON_STYLE,
                          },
                          '继续游戏',
                        ),
                      ),
                ),
              ),
            ),
          ),

          // 本地受控独立预览列表（独立路径，不走 catalogInstall）
          previewEntries.length > 0 &&
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' } },
              h('h4', { style: { margin: 0, fontSize: '14px', color: '#57606a' } }, '本地受控预览'),
              previewEntries.map((/** @type {PreviewEntry} */ p) =>
                h(
                  'div',
                  {
                    key: p.previewId,
                    'data-gamecenter-preview': p.previewId,
                    style: {
                      padding: '10px 12px',
                      border: '1px dashed #d0d7de',
                      borderRadius: '8px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    },
                  },
                  h(
                    'div',
                    null,
                    h('span', { style: { fontWeight: 600 } }, `${p.name} v${p.version}`),
                    h('span', { style: { marginLeft: '8px', fontSize: '12px', color: '#9a6700' } }, p.label || '本地预览（未上架）'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-gamecenter-action': 'preview',
                      onClick: () => void handleLaunchPreview(p),
                      style: BUTTON_STYLE,
                    },
                    '启动预览',
                  ),
                ),
              ),
            ),
        ),

      // 3. 诊断区（直接作为 dialog 子节点渲染，保证测试与实际诊断稳定挂载）
      runDiagnostics !== null && typeof runDiagnostics === 'function' && !runningSession
        ? h(RemoteDiagnostics, { remoteState, getService, makeNonce, runDiagnostics })
        : null,

      // 底部操作区（非游戏运行时显示）
      !runningSession &&
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
          h(
            'button',
            {
              type: 'button',
              'data-gamecenter-action': 'back-to-list',
              onClick: () => void close('back-to-list'),
              disabled: phase === 'pausing',
              style: BUTTON_STYLE,
            },
            '返回列表',
          ),
          h(
            'button',
            {
              type: 'button',
              'data-gamecenter-action': 'close',
              onClick: () => void close('close'),
              disabled: phase === 'pausing',
              style: BUTTON_STYLE,
            },
            '关闭',
          ),
        ),
    ),
  );
}

const MASK_STYLE = Object.freeze({
  position: 'fixed',
  inset: '0',
  background: 'rgba(0, 0, 0, 0.32)',
  zIndex: '1000',
});

const DIALOG_STYLE = Object.freeze({
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(640px, 92vw)',
  maxHeight: '85vh',
  overflow: 'auto',
  padding: '24px',
  borderRadius: '12px',
  background: 'var(--dsw-alias-bg-base, #fff)',
  color: 'var(--dsw-alias-label-primary, #111)',
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.24)',
  zIndex: '1001',
});

const RUNNING_DIALOG_STYLE = Object.freeze({
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(760px, 96vw)',
  maxHeight: '92vh',
  overflow: 'auto',
  padding: '20px',
  borderRadius: '12px',
  background: 'var(--dsw-alias-bg-base, #fff)',
  color: 'var(--dsw-alias-label-primary, #111)',
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.24)',
  zIndex: '1001',
});

const BUTTON_STYLE = Object.freeze({
  padding: '6px 14px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
});

const TAB_STYLE = Object.freeze({
  padding: '4px 10px',
  borderRadius: '6px',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #57606a)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '13px',
});

const ACTIVE_TAB_STYLE = Object.freeze({
  padding: '4px 10px',
  borderRadius: '6px',
  border: 'none',
  background: 'var(--dsw-alias-bg-subtle, #f6f8fa)',
  color: 'var(--dsw-alias-label-primary, #111)',
  fontWeight: 600,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '13px',
});
