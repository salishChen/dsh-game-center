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
import { DiagnosticsDialog } from './DiagnosticsDialog.js';
import { GameLibrary } from './GameLibrary.js';
import { selectVisibleEntries, countHiddenEntries } from './catalog-visibility.js';
// 【提交判定唯一入口 · 2026-10-27】目录 commit 与磁盘已装 commit 不是一回事，见 entry-commit.js。
import { resolveEntryCommit } from './entry-commit.js';
// 【存档可选 · 2026-10-21】能力判定只认协议这一份实现，禁止在此再写 `manifest.save?.x`。
// 注意：protocol 不在构建的 STATIC_EXTERNALS 里，会被打进 client.js（候选 hash 必变）。
import { AiModelSelector } from './AiModelSelector.js';
import {WhaleWallet} from './WhaleWallet.js';
import {ArenaOpponentPicker} from './ArenaOpponentPicker.js';
import {ArenaPortrait} from './ArenaPortrait.js';
import { hasSaveCapability, getSaveMode } from '@dsh-gamecenter/protocol';

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
 * @typedef {object} CatalogDisplay
 * @property {number} [schemaVersion]
 * @property {string} [repository]
 * @property {string} [summary]
 * @property {string} [descriptionMarkdown] 受限 Markdown 简介（安全渲染）
 * @property {any} [cover] 封面元数据（媒体本轮禁用，显示占位）
 * @property {any[]} [screenshots] 截图元数据（媒体本轮禁用，显示占位）
 * @property {any} [compatibility]
 */

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
 * @property {CatalogDisplay} [display] 展示元数据（简介/媒体/兼容范围）
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
 * @param {'overlay' | 'page'} [props.presentation] 呈现方式：
 *   - `overlay`（默认）：既有 shell.overlay 弹层形态，含遮罩与「游戏库/链路诊断」Tab；
 *   - `page`：作为主内容区**页面**呈现（2026-10-20 用户改版）。无遮罩、无 Tab，
 *     诊断弹窗由页面右上角按钮控制，游戏库常驻内容区。
 * @param {boolean} [props.diagnosticsOpen] page 模式下由页面控制的诊断弹窗开关
 * @param {any} [props.sessionController] 插件作用域的会话控制器（v3 导航收尾用）
 * @param {any} [props.themeBridge] DSH 主题桥（v3：主题经已配对 MessagePort 下发）
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
  presentation = 'overlay',
  diagnosticsOpen = false,
  sessionController = null,
  themeBridge = null,
}) {
  const isPage = presentation === 'page';
  const [open, setOpen] = useState(overlay.open);
  const [activeTab, setActiveTab] = useState(/** @type {'games' | 'diagnostics'} */ ('games'));
  /** page 模式：会话控制器状态快照（运行中/收敛中/已保存/失败）。 */
  const [sessionSnapshot, setSessionSnapshot] = useState(
    /** @type {{state: string, message: string | null} | null} */ (null),
  );
  const [phase, setPhase] = useState(/** @type {'idle' | 'pausing' | 'paused' | 'recovery'} */ ('idle'));
  const [notice, setNotice] = useState(/** @type {string | null} */ (null));
  const [frameMode, setFrameMode] = useState(/** @type {'srcdoc' | 'blob'} */ ('srcdoc'));

  // 目录列表与预览状态
  const [catalogSource, setCatalogSource] = useState(/** @type {string | null} */ (sessionController?.snapshot().session?.catalogSource ?? null));
  const [catalogEntries, setCatalogEntries] = useState(/** @type {CatalogEntry[]} */ (sessionController?.snapshot().session?.catalogEntries ?? []));
  const [previewEntries, setPreviewEntries] = useState(/** @type {PreviewEntry[]} */ ([]));
  const [catalogLoading, setCatalogLoading] = useState(false);
  /** 上次成功扫描时间（Host 快照的 fetchedAt），用于"先显示旧数据 + 扫描时间"。 */
  const [catalogScannedAt, setCatalogScannedAt] = useState(/** @type {string | null} */ (null));
  /** 当前列表是否来自缓存旧数据（刷新未完成或网络失败降级）。 */
  const [catalogStale, setCatalogStale] = useState(false);
  /** 后台刷新进行中（与首屏读取区分：首屏立即出缓存，不转圈等网络）。 */
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  /** 单飞：同一次进入只允许一条目录请求在飞，重复触发复用同一个 Promise。 */
  const catalogInFlight = useRef(/** @type {Promise<void> | null} */ (null));
  /** 本次"进入游戏中心"是否已经触发过自动扫描（返回列表不算重新进入）。 */
  const autoScanned = useRef(false);
  const [catalogError, setCatalogError] = useState(/** @type {string | null} */ (null));
  const [installingGameId, setInstallingGameId] = useState(/** @type {string | null} */ (null));
  const [uninstallingGameId, setUninstallingGameId] = useState(/** @type {string | null} */ (null));
  const [installError, setInstallError] = useState(/** @type {string | null} */ (null));

  // 当前运行中的游戏会话
  const [runningSession, setRunningSession] = useState(/** @type {any | null} */ (isPage ? sessionController?.snapshot().session ?? null : null));

  // 【导航收尾 · v3】PM 点名：React cleanup 是同步的，不能 await；
  // fire-and-forget 会让 iframe 在存档写完前就被卸载（假象保存）。
  // 因此导航离开的收敛交给**插件作用域的 sessionController**：
  // 它把 iframe 放在脱离 React 树的 detached host 里，先走完
  // requestPause → 落盘确认 → saveAck 封存 → dispose，再销毁容器。
  // page 模式下由页面组件调用 controller.finalize()；这里不再自带
  // "卸载即保存"的 effect（那正是要消除的反模式）。
  useEffect(() => {
    if (!isPage) return undefined;
    if (sessionController === null || typeof sessionController.subscribe !== 'function') return undefined;
    // 订阅控制器状态：收敛中/失败时让页面渲染对应占位（不卸载容器）。
    const unsubscribe = sessionController.subscribe(() => {
      const snap = sessionController.snapshot();
      setSessionSnapshot(snap);
      setRunningSession(snap.session);
    });
    setSessionSnapshot(sessionController.snapshot());
    return unsubscribe;
  }, [isPage, sessionController]);

  const dialogRef = useRef(/** @type {any} */ (null));
  const iframeRef = useRef(/** @type {HTMLIFrameElement | null} */ (null));
  /**
   * page 模式下的 iframe 占位元素。窗口 resize、页面滚动、DSH 侧栏收放都会改变它
   * 的矩形，而 iframe 是用 CSS `position: fixed` 贴在矩形上的——不重新对齐的话
   * 游戏会停在旧位置/旧尺寸（用户反馈"打开游戏后窗口大小不对"）。
   */
  const frameSlotRef = useRef(/** @type {any} */ (null));
  /**
   * 在途 AI 请求的取消器（2026-10-21）。
   *
   * Host 的 `aiGenerate` 末位形参是 AbortSignal；Client 必须真的传一个可取消的 signal，
   * 否则关闭/暂停时 Host 只能"事后丢弃结果"（QA 实测到的就是这一点：Broker 收到的
   * signal 是 undefined，慢任务继续空转、真实模型还会继续计费）。
   */
  const aiAbortRef = useRef(/** @type {AbortController | null} */ (null));
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
      let timer;
      try {
        const service = getService();
        if (!service || typeof service.abandonRuntime !== 'function') return;
        await Promise.race([service.abandonRuntime({ launchToken, runtimeInstanceId }), new Promise(resolve => {timer = setTimeout(resolve, 3000);})]);
      } catch (err) {
        // 失败不得阻塞关闭；只在控制台留痕，不把令牌写进任何消息。
        console.warn('[GameCenterOverlay] abandonRuntime 调用失败（不影响关闭）');
      } finally { clearTimeout(timer); }
    },
    [getService],
  );

  /**
   * 撤销租约并**返回是否拿到确认**。
   *
   * 无存档游戏的关闭必须"先撤销拿到确认，再销毁容器"；`abandonLaunch` 会吞掉错误
   * 且不回报结果，不能用来判断。撤销失败时只做有界清理，并如实说明"未确认撤销"，
   * 不伪称已撤销。
   *
   * @type {(session: any) => Promise<boolean>}
   */
  const revokeLeaseConfirmed = useCallback(
    async (/** @type {any} */ session) => {
      if (!session) return false;
      const launchToken = typeof session.launchToken === 'string' ? session.launchToken : '';
      const runtimeInstanceId = typeof session.runtimeInstanceId === 'string' ? session.runtimeInstanceId : '';
      if (launchToken === '' || runtimeInstanceId === '') return false;
      let timer;
      try {
        const service = getService();
        if (!service || typeof service.abandonRuntime !== 'function') return false;
        const res = await Promise.race([service.abandonRuntime({launchToken, runtimeInstanceId}), new Promise(resolve => {timer = setTimeout(() => resolve(null), 3000);})]);
        return Boolean(res && res.ok === true);
      } catch { return false; } finally { clearTimeout(timer); }
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

  /**
   * 应用一次目录响应。
   *
   * 失败时**不清空列表**：保留上一次的 entries 与扫描时间，只标 stale + 错误，
   * 否则网络抖一下玩家就看不到自己的游戏库。
   */
  const applyCatalogResult = useCallback((/** @type {any} */ res) => {
    if (res && res.ok === true) {
      setCatalogSource(res.source);
      setCatalogEntries(Array.isArray(res.entries) ? res.entries : []);
      setCatalogScannedAt(typeof res.fetchedAt === 'string' ? res.fetchedAt : null);
      setCatalogStale(res.stale === true);
      setCatalogError(res.error?.message ?? null);
      return;
    }
    setCatalogError(res?.message || '获取游戏目录失败');
    setCatalogStale(true);
  }, []);

  /**
   * 加载目录：**先显示上次结果，再后台刷新**。
   *
   * - `refresh=false`：只读 Host 缓存快照（立即返回，可能 stale）。
   * - `refresh=true`：先读一次缓存快照立刻上屏（有就显示，不等网络），再发真实刷新；
   *   刷新失败时保留旧数据并给出错误与重试入口。
   * - 单飞：同一次进入里重复触发（页面重渲染、按钮连点）合并成一个 Promise。
   *
   * 审批不因缓存放宽：`approvalState` 只是展示，安装/启动仍由 Host 实时复核。
   */
  const loadCatalog = useCallback(
    (refresh = false) => {
      const service = getService();
      if (!service || typeof service.catalogList !== 'function') {
        return Promise.resolve();
      }
      if (catalogInFlight.current !== null) return catalogInFlight.current;

      const run = (async () => {
        setCatalogLoading(true);
        setCatalogError(null);
        try {
          if (refresh) {
            // 1) 先上旧快照（不等待网络；失败也不影响后面刷新）
            try {
              applyCatalogResult(await service.catalogList({ refresh: false }));
            } catch {
              // 首屏缓存读不到就继续走刷新，不在这里报错
            }
            // 2) 后台刷新
            setCatalogRefreshing(true);
            try {
              applyCatalogResult(await service.catalogList({ refresh: true }));
            } finally {
              setCatalogRefreshing(false);
            }
          } else {
            applyCatalogResult(await service.catalogList({ refresh: false }));
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
          // 保留旧数据，只标 stale 并报错
          setCatalogStale(true);
          setCatalogError(e.message || '获取游戏目录异常');
        } finally {
          setCatalogLoading(false);
        }
      })();

      catalogInFlight.current = run;
      void run.finally(() => {
        if (catalogInFlight.current === run) catalogInFlight.current = null;
      });
      return run;
    },
    [getService, applyCatalogResult],
  );

  // 【进入即自动扫描 · 2026-10-21】只在"进入游戏中心"时触发一次（页面模式=挂载，
  // 弹层模式=打开），显式刷新走按钮；不随 render/条目数变化重复扫描。
  // 从对局返回列表不算重新进入（autoScanned 保持 true），避免每局回来都扫一次。
  useEffect(() => {
    if (runningSession) return;
    const visible = isPage || open;
    if (!visible) {
      autoScanned.current = false;
      return;
    }
    if (autoScanned.current) return;
    autoScanned.current = true;
    void loadCatalog(true);
  }, [isPage, open, runningSession, loadCatalog]);

  /**
   * 唯一关闭收敛点：暂停游戏、结算代次、清空会话与资源。
   *
   * page 模式走 sessionController（v3）：它保证 iframe 在最终 checkpoint ack
   * 之前不被销毁；overlay 模式保持原有内联流程（行为不变）。
   *
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
        // 关闭/返回列表时先取消在途 AI 请求：Host 收到 abort 会中断 Broker，
        // 不必等慢任务跑完再丢弃结果（真实模型下这也是在烧钱）。
        if (aiAbortRef.current !== null) {
          try {
            aiAbortRef.current.abort('gamecenter-close');
          } catch {}
          aiAbortRef.current = null;
        }
        // 【无存档游戏关闭 · 2026-10-21】顺序不可颠倒（PM 纠正后的口径）：
        //   1) 停止输入并让游戏停止接新请求；
        //   2) 向 Host 撤销租约并**拿到确认**；
        //   3) 释放 MessagePort 与主题通道；
        //   4) 最后销毁容器。
        // 绝不先 dispose——撤销请求要靠这条调用通道。没有存档就不进保存确认链。
        if (runningSession?.supportsSave === false || runningSession?.supportsResume === false) {
          const flashSaved=runningSession.gameId==='example.crazy-flasher4'?await saveFlashBeforeClose(runningSession,getService()):false;
          if (runningSession.gameId!=='example.crazy-flasher4'&&runningSession.dispatcher?.control) { try { await runningSession.dispatcher.control('suspend'); } catch {} }
          const revoked = await revokeLeaseConfirmed(runningSession);
          if (runningSession.dispatcher) runningSession.dispatcher.dispose();
          if (typeof runningSession.unbindTheme === 'function') runningSession.unbindTheme();
          if (runningSession.blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(runningSession.blobUrl);
          }
          if (isPage && sessionController !== null) sessionController.abandon();
          setRunningSession(null);
          setPhase('paused');
          setNotice(
            revoked
              ? flashSaved?'当前游戏进度已保存，游戏已关闭。':runningSession.gameId==='example.crazy-flasher4'?'游戏已关闭（尚未开始，无需保存）':'对局已结束（该游戏不支持存档，本次未保存）'
              : '对局已结束（该游戏不支持存档）；租约撤销未获确认，已做有界清理',
          );
          return;
        }
        if (isPage && sessionController !== null) {
          // page 模式：交给插件作用域控制器，容器在 ack 后才销毁。
          const outcome = await sessionController.finalize(reason);
          setNotice(outcome.message);
          const ended = outcome.kind === 'saved' || outcome.kind === 'closed';
          setPhase(ended ? 'paused' : 'recovery');
          if (ended) {
            await abandonLaunch(runningSession);
            setRunningSession(null);
          } else {
            // 未确认保存：保留会话与容器，让玩家看到真实状态并可重试。
            setRunningSession(null);
            return;
          }
        } else {
          const pauseService = getService();
          if (!pauseService?.pause) throw new Error('Host 暂停服务未就绪');
          const accepted = await pauseService.pause({runtimeToken:runningSession?.runtimeToken, generation:runningSession?.lease?.generation, reason});
          if (accepted?.accepted !== true) throw new Error(accepted?.error?.message || 'Host 未确认暂停');
          const paused = requestPause(reason);
          if (runningSession?.dispatcher) {
            runningSession.dispatcher.triggerPause({ reason });
          }
          const outcome = await paused;
          setNotice(outcome.message);
          setPhase(outcome.kind === 'saved' ? 'paused' : 'recovery');

          if (runningSession?.blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(runningSession.blobUrl);
          }
          if (runningSession?.dispatcher) {
            runningSession.dispatcher.dispose();
          }
          // 解绑主题：游戏已结束，不再接收 DSH 主题变化。
          if (typeof runningSession?.unbindTheme === 'function') {
            runningSession.unbindTheme();
          }
          // 【放弃启动】关闭路径统一通知 Host 撤销本次启动。
          // 已正常保存的场景下 Host 侧应幂等返回（reclaimed:false）；若 pause 超时/崩溃，
          // 这一步能把"未确认/无人持有"的租约立刻回收，不等 3s 窗口。
          await abandonLaunch(runningSession);
          setRunningSession(null);
        }
      } finally {
        busy.current = false;
        // 如果是在游戏运行时点击“返回列表”，不关闭整个弹层，仅退出游戏
        if (reason === 'close' || reason === 'escape' || !runningSession) {
          onClosed();
          overlay.set(false);
        }
      }
    },
    [requestPause, onClosed, overlay, runningSession, abandonLaunch, isPage, sessionController, revokeLeaseConfirmed],
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

  // 卸载已安装游戏（仅清理代码包，存档安全保留）
  const handleUninstall = async (/** @type {CatalogEntry} */ entry) => {
    if (!entry.installed) return;
    setUninstallingGameId(entry.gameId);
    setInstallError(null);
    try {
      const service = getService();
      if (!service || typeof service.catalogUninstall !== 'function') {
        throw new Error('Remote catalogUninstall 服务未就绪');
      }
      // 【卸载必须打真实安装提交 · 2026-10-27】entry.commit 是「目录里的最新发布版」，
      // 磁盘上真正装了的那份是 installedCommit。两者不等时（游戏反复重建、扫雷/斗地主发过多版），
      // 用前者去删删的是一个不存在的路径，而 fs.rm(force:true) 对不存在的路径同样返回成功
      // → 假成功：界面乐观置为未安装，紧接着按真实磁盘重算又弹回「已安装」，且没有安装入口。
      const targetCommit = resolveEntryCommit(entry);
      const res = await service.catalogUninstall({
        gameId: entry.gameId,
        commit: targetCommit,
      });
      if (res && res.ok === true) {
        setCatalogEntries((/** @type {CatalogEntry[]} */ prev) =>
          prev.map((e) => (e.gameId === entry.gameId ? { ...e, installed: false, installedCommit: null } : e)),
        );
        setNotice(`已成功卸载《${entry.title}》，游戏存档已完好保留。`);
        // 【卸载后必须重算 · 2026-10-26】乐观清标记只够撑到下一次刷新：一旦刷新，
        // Host 的磁盘判定会覆盖回来。卸载是磁盘状态变更，必须立刻按真实磁盘重拉一次，
        // 否则「刷新目录后还能继续卸载、点开始游戏必报未找到已安装版本」会复现。
        void loadCatalog(true);
      } else {
        setInstallError(`${res?.errorCode || 'UNINSTALL_FAILED'}: ${res?.message || '卸载失败'}`);
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      setInstallError(e.message || '卸载调用失败');
    } finally {
      setUninstallingGameId(null);
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

      // 【启动必须打真实安装提交 · 2026-10-27】与卸载同源：装在旧版本时用 entry.commit
      // 去取产物/握手，Host 找不到该提交的安装目录，必然报「未找到已安装版本」。
      // installedCommit 才是磁盘上那份的提交号；缺省（如刚装完尚未刷新）才退回 entry.commit。
      const targetCommit = resolveEntryCommit(entry);

      // 【先取产物再判能力 · 2026-10-21】能力声明来自固定提交里的 gamecenter.json，
      // 必须先拿到 bundle 才知道这个游戏到底支不支持存档——顺序反了就会对无存档游戏
      // 先发一次 saveLatest（Host 只能回 SAVE_UNSUPPORTED）。
      const bundleRes = await service.gameBundle({ gameId: entry.gameId, commit: targetCommit });
      if (!bundleRes || bundleRes.ok !== true) {
        throw new Error(bundleRes?.message || '获取游戏资源失败');
      }

      // 只认协议的能力函数；manifest 缺失/损坏时按"无存档"处理（不放宽为强制保存）。
      const supportsSave = (() => {
        const files = Array.isArray(bundleRes.files) ? bundleRes.files : [];
        const manifestFile = files.find((/** @type {any} */ f) => f && f.path === 'gamecenter.json');
        if (!manifestFile || typeof manifestFile.content !== 'string') throw new Error('缺少可信 manifest');
        try {
          return hasSaveCapability(JSON.parse(manifestFile.content)) === true;
        } catch {
          throw new Error('游戏 manifest 损坏');
        }
      })();
      const supportsResume = supportsSave && getSaveMode(JSON.parse(bundleRes.files.find((/** @type {any} */ f) => f.path === 'gamecenter.json').content)) === 'resumable';

      let initialElapsedMs = 0;
      let initialRngState = '';
      let initialRevision = 0;

      // 无存档游戏一律不读检查点：既不发无意义的 Host 请求，也不给玩家"看起来能续玩"的假象。
      if (isResume && supportsSave && supportsResume && typeof service.saveLatest === 'function') {
        const saveRes = await service.saveLatest({ gameId: entry.gameId, saveId, commit: targetCommit });
        if (saveRes && saveRes.ok === true) {
          if (saveRes.absent === false) {
            if (saveRes.installedCommit && saveRes.installedCommit !== targetCommit) {
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
      } else if (isResume && !supportsSave) {
        // 如实告知：这个游戏没有存档能力，不是"没找到存档"。
        setNotice('该游戏不支持存档，本次为全新对局');
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
          commit: targetCommit,
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
        commit: targetCommit,
        title: entry.title,
        // 存档能力随会话带上：关闭路径据此决定"保存确认"还是"直接结束对局"。
        supportsSave,
        supportsResume,
        aiSlots: Object.keys(JSON.parse(bundleRes.files.find((/** @type {any} */ f) => f.path === 'gamecenter.json').content).ai?.slots || {}),
        abortAi: () => aiAbortRef.current?.abort('USER_CANCELLED'),
        catalogEntries, catalogSource,
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
          previewId: previewEntry.previewId,
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
        // 本地受控预览不参与存档：关闭即结束，走无存档的收敛路径。
        supportsSave: false,
        supportsResume: false,
        aiSlots: Object.keys(JSON.parse(bundleRes.files.find((/** @type {any} */ f) => f.path === 'gamecenter.json').content).ai?.slots || {}),
        abortAi: () => aiAbortRef.current?.abort('USER_CANCELLED'),
        catalogEntries, catalogSource,
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
      const iframeWin = (isPage ? sessionController?.getFrame?.() : iframeRef.current)?.contentWindow;
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

      if (runningSession.dispatcher) return;
      openInput(runningSession.lease);

      const channel = new MessageChannel();

      const dispatcher = createBridgeDispatcher({
        lease: runningSession.lease,
        port: channel.port1,
        onCheckpoint: async (input) => {          const service = getService();
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
          if (!service?.saveAck || !runningSession.runtimeToken) throw new Error('Host 保存确认服务未就绪');
          const confirmed = await service.saveAck({
            runtimeToken: runningSession.runtimeToken,
            revision: payload.revision,
            generation: payload.generation,
          });
          if (confirmed?.accepted !== true) throw new Error(confirmed?.error?.message || 'Host 未确认保存');
          if (typeof onSaveAck === 'function' && runningSession.lease) {
            onSaveAck({ generation: payload.generation, revision: payload.revision });
          }
        },
        // 【AI 转发 · 2026-10-21】此前装配 dispatcher 时**没传** onAiGenerate，
        // dispatcher 兜底回一条纯文本 fixture，扫雷 validateBoardGeneration 校验失败
        // 后静默降级——这就是"扫雷连 AI 连不上"的真实断点之一。
        // 这里把请求原样转给 Host 的 aiGenerate；Host 端点还没就绪时抛出明确的
        // CAPABILITY_UNAVAILABLE（游戏据此提示重试或改玩经典），**不伪造成功**。
        // 本转发不持有任何 provider 凭据，模型选择与额度全由 Host 决定。
        onWalletCommand: async (input) => {
          if (!['example.cat-arena','example.crazy-flasher4'].includes(runningSession.gameId)) throw new Error('该游戏无钱包权限');
          const service=getService();if(!service?.walletAction)throw new Error('钱包服务尚未加载');
          const result=await service.walletAction({...input,runtimeToken:runningSession.runtimeToken});
          if(!result?.ok)throw Object.assign(new Error(result?.message||'钱包操作失败'),{code:result?.errorCode});
          if(input.action==='exchange')window.dispatchEvent(new Event('gamecenter:wallet-updated'));
          return result;
        },
        onGameCommand: async (input) => {
          if (runningSession.gameId === 'example.cat-arena') {
            if(input?.action==='arenaPhase'){
              if(!['garage','battle','finished'].includes(input.phase))throw Error('界面阶段不合法');
              runningSession.arenaPhase=input.phase;sessionController?.notify?.();return {ok:true};
            }
            if(input?.action==='arenaOpponent'){
              if(!runningSession.arenaOpponent)throw Error('请先选择 AI 对手');
              const state=await getService()?.arenaAction({runtimeToken:runningSession.runtimeToken,action:'state',operationId:input.operationId});
              if(!state?.ok)throw Error(state?.message||'模式服务未就绪');return {ok:true,opponent:runningSession.arenaOpponent,roundId:state.roundId};
            }
            const result=await getService()?.arenaAction({...input,runtimeToken:runningSession.runtimeToken});
            if(!result?.ok)throw Object.assign(new Error(result?.message||'模式服务未就绪'),{code:result?.errorCode});
            if(input.action==='mode'||input.action==='reset'){runningSession.arenaMode=result.mode;runningSession.arenaPhase='garage';runningSession.arenaOpponent=null;runningSession.arenaPicking=false;sessionController?.notify?.();}else if(input.action==='next'){runningSession.arenaPhase='garage';sessionController?.notify?.();}return result;
          }
          if (runningSession.gameId !== 'example.landlord') throw new Error('该游戏不支持牌局命令');
          const service = getService();
          if (!service?.landlordAction) throw new Error('斗地主 Host 尚未加载，请重载应用');
          const controller = new AbortController();
          if (input?.action === 'ai') {
            aiAbortRef.current = controller; runningSession.aiBusy = true;
            runningSession.aiStatus = '电脑正在思考'; sessionController?.notify?.();
          }
          try {
            const result = await service.landlordAction({...input, runtimeToken:runningSession.runtimeToken}, controller.signal);
            if (!result?.ok) throw Object.assign(new Error(result?.message || '牌局命令失败'), {code:result?.errorCode});
            if (result.decision) runningSession.aiStatus = result.decision.source === 'ai'
              ? `电脑 ${result.decision.seat}：${result.decision.binding?.modelId} / ${result.decision.binding?.reasoningEffort || '提供方默认'} · ${result.decision.elapsedMs}ms`
              : `电脑 ${result.decision.seat}：本地策略（${result.decision.reason || '未选择模型'}）`;
            return result;
          } finally {
            if (aiAbortRef.current === controller) { aiAbortRef.current = null; runningSession.aiBusy = false; sessionController?.notify?.(); }
          }
        },
        onAiCancel: async (input) => {
          if (runningSession.activeOperationId === input.operationId) aiAbortRef.current?.abort('USER_CANCELLED');
          await getService()?.cancelAi({runtimeToken:runningSession.runtimeToken, operationId:input.operationId});
        },
        onAiGenerate: async (/** @type {any} */ input) => {
          const service = getService();
          if (!service || typeof service.aiGenerate !== 'function') {
            const missing = new Error('AI 生成暂不可用：Host 未提供 aiGenerate 端点');
            /** @type {any} */ (missing).code = 'CAPABILITY_UNAVAILABLE';
            throw missing;
          }
          // 每次调用一个可取消的 signal：关闭/暂停时由 aiAbortRef 触发 abort，
          // Host 端据此中断底层 Broker，而不是等它跑完再丢结果。
          const controller = typeof AbortController === 'function' ? new AbortController() : null;
          aiAbortRef.current = controller;
          runningSession.activeOperationId = input?.operationId;
          runningSession.aiBusy = true;
          runningSession.aiStatus = '正在请求所选模型';
          sessionController?.notify?.();
          try {
            const aiRes = await service.aiGenerate(
              {
                runtimeToken: runningSession.runtimeToken,
                operationId: input?.operationId,
                slot: input?.slot,
                input: input?.input,
              },
              controller !== null ? controller.signal : undefined,
            );
            if (!aiRes || aiRes.ok !== true) {
              const err = new Error(aiRes?.message || 'AI 生成失败');
              /** @type {any} */ (err).code = aiRes?.errorCode || 'INTERNAL';
              /** @type {any} */ (err).retryable = Boolean(aiRes?.retryable);
              throw err;
            }
            if (aiAbortRef.current === controller) runningSession.aiStatus = `请求完成 ${aiRes.binding?.modelId || ''} ${aiRes.binding?.reasoningEffort || ''}（${aiRes.elapsedMs ?? 0}ms）`;
            return aiRes;
          } catch (error) {
            if (aiAbortRef.current === controller) runningSession.aiStatus = 'AI 请求失败，请在游戏中重试';
            if (controller?.signal.aborted) throw Object.assign(new Error('生成已取消'), {code:'CANCELLED'});
            throw error;
          } finally {
            if (aiAbortRef.current === controller) {
              aiAbortRef.current = null;
              runningSession.aiBusy = false;
              sessionController?.notify?.();
            }
          }
        },
      });

      runningSession.dispatcher = dispatcher;

      // 【主题通道 · v3】端口已建立（握手通过），把 DSH 主题经这条已配对端口
      // 下发给游戏：bind 会立即下发一次初值，之后随 DSH 主题变化持续同步。
      // 只在主题服务可用时启用；取不到就不猜，游戏沿用自身默认。
      if (themeBridge !== null && typeof themeBridge.bind === 'function' && themeBridge.available === true) {
        const unbind = themeBridge.bind(
          /** @type {(mode: 'dark' | 'light', source: 'dsh' | 'os') => boolean} */ (mode, source) =>
            dispatcher.sendTheme(mode, source),
        );
        runningSession.unbindTheme = unbind;
      }

      // 向沙箱 iframe 投递专用 MessagePort
      iframeWin.postMessage({ type: 'dsh-gamecenter:port', nonce: runningSession.nonce }, '*', [channel.port2]);
    };

    window.addEventListener('message', onWindowMessage);
    return () => {
      window.removeEventListener('message', onWindowMessage);
    };
  }, [runningSession, onSaveAck, getService]);

  // 【兜底】会话被清空（含页面卸载/visibility 收敛路径）时取消残留的在途 AI 请求。
  useEffect(() => {
    if (runningSession !== null) return;
    if (aiAbortRef.current !== null) {
      try {
        aiAbortRef.current.abort('gamecenter-session-ended');
      } catch {}
      aiAbortRef.current = null;
    }
  }, [runningSession]);

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

  // 【铺满跟随 · 2026-10-21 用户反馈】page 模式下 iframe 是用 CSS `position: fixed`
  // 贴在占位矩形上的：窗口缩放、内容区滚动、DSH 侧栏收放都会改变矩形。不重新对齐，
  // 游戏就会停在打开时刻的旧尺寸/旧位置。这里只在**已运行**时挂监听，且只调用
  // `align`（改 CSS），不移动 iframe 的父节点，因此不会重建 browsing context。
  useEffect(() => {
    if (!isPage || sessionController === null || runningSession === null) return undefined;
    const realign = () => {
      const node = frameSlotRef.current;
      if (node === null) return;
      sessionController.align(node);
    };
    window.addEventListener('resize', realign);
    // 捕获阶段监听：DSH 的内容区可能是内部滚动容器，滚动事件不冒泡到 window。
    window.addEventListener('scroll', realign, true);
    /** @type {ResizeObserver | null} */
    let observer = null;
    const slot = frameSlotRef.current;
    if (slot !== null && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(realign);
      observer.observe(slot);
    }
    // 首帧布局可能还没稳定（侧栏动画/字体加载），再补一次对齐。
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(realign) : null;
    return () => {
      window.removeEventListener('resize', realign);
      window.removeEventListener('scroll', realign, true);
      if (observer !== null) observer.disconnect();
      if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    };
  }, [isPage, sessionController, runningSession]);

  const bindFrameSlot = useCallback((/** @type {any} */ node) => {
    frameSlotRef.current = node;
    if (!sessionController) return;
    if (node === null) { void sessionController.unbind?.(); return; }
    if (!runningSession) return;
    const snap = sessionController.snapshot();
    if (snap.session === null) sessionController.attach(runningSession, {sandbox:GAME_IFRAME_SANDBOX, frameMode, anchor:node});
    else void sessionController.bind?.(node);
  }, [sessionController, runningSession, frameMode]);

  // 【只显示已审批游戏】用户要求：列表中不显示审核中的游戏。
  // 判定口径见 ui/catalog-visibility.js（抽成纯函数以便直接断言）。
  const isFixtureSource = catalogSource === 'fixture';
  /** @type {CatalogEntry[]} */
  const visibleEntries = selectVisibleEntries(catalogEntries, isFixtureSource);
  const hiddenCount = countHiddenEntries(catalogEntries, isFixtureSource);

  // 展示层只接收已过滤目录；审批、安装和启动仍由原 Host 链路裁决。
  const catalogListNode = h(GameLibrary, {
    entries: visibleEntries, previews: previewEntries, fixture: isFixtureSource, hiddenCount,
    loading: catalogLoading, refreshing: catalogRefreshing, error: catalogError, installError,
    installingGameId, uninstallingGameId, scannedAt: catalogScannedAt, stale: catalogStale,
    onRefresh: () => void loadCatalog(true),
    onInstall: (/** @type {CatalogEntry} */ entry) => void handleInstall(entry),
    onUninstall: (/** @type {CatalogEntry} */ entry) => void handleUninstall(entry),
    onLaunch: (/** @type {CatalogEntry} */ entry) => void handleLaunchGame(entry, true),
    onPreview: (/** @type {PreviewEntry} */ entry) => void handleLaunchPreview(entry),
  });

  // 【page 模式】作为主内容区页面呈现：常驻渲染，不受 open 影响，
  // 无遮罩、无 aria-modal；诊断弹窗的开关由页面右上角按钮经 diagnosticsOpen 控制。

  if (isPage) {
    return h(
      'div',
      {
        'data-gamecenter-page-content': '',
        'data-gamecenter-phase': phase,
        // 【铺满 · 2026-10-21 用户要求】游戏运行时要占满"页面头部下方"的全部内容区，
        // 不是 420px 的小窗。page-content 必须自己可伸展，否则它内部的 flex 子项
        // 只能按内容高度算，iframe 永远停在 minHeight。
        style: { display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0, flex: '1 1 auto' },
      },
      phase === 'pausing' ? h('p', { 'aria-live': 'polite', style: { margin: 0, color: 'var(--dsw-alias-state-info-primary, #0969da)' } }, t('pausing')) : null,
      notice !== null ? h('p', { role: 'status', style: { margin: 0, color: 'var(--dsw-alias-label-primary, CanvasText)' } }, notice) : null,


      // 1. 运行中模式：受控 iframe
      //    - page 模式：iframe 由 sessionController 命令式挂到下面的容器 ref 里，
      //      脱离 React 树——导航离开时容器可被卸载而 iframe 不亡，
      //      直到收敛（落盘 ack）完成才销毁（PM 硬要求）。
      //    - overlay 模式：保持既有 React 内联 iframe（弹层形态，行为不变）。
      runningSession !== null &&
        h(
          'div',
          { 'data-gamecenter-game-active': '', className:'gc-runtime', style: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, flex: '1 1 auto' } },
          h(
            'div',
            {
              className: 'gc-runtime-controls',
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
                color: 'var(--dsw-alias-label-primary, CanvasText)',
                borderRadius: '8px',
                flexWrap: 'wrap',
                gap: '8px',
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minWidth: 0 } },
              h('span', { style: { fontWeight: 600 } }, runningSession.gameId === 'example.cat-arena' ? '鲸械竞技场' : runningSession.title),
              ...(runningSession.gameId==='example.cat-arena'?[]:runningSession.aiSlots || []).map((/** @type {string} */ slot) => h(AiModelSelector, {key:slot, slot, session:runningSession, getService, onChange:() => sessionController?.notify?.()})),
              runningSession.gameId==='example.cat-arena'&&runningSession.arenaMode==='duel'&&runningSession.arenaOpponent&&h('div',{className:'gc-arena-opponent-current'},
                h(ArenaPortrait,{personaId:runningSession.arenaOpponent.familyId}),
                h('span',{},runningSession.arenaOpponent.name,h('small',{},`${runningSession.arenaOpponent.binding.modelId} · ${runningSession.arenaOpponent.binding.reasoningEffort||'提供方默认'}`)),
                h('button',{type:'button',className:'gc-button gc-button-quiet',disabled:runningSession.aiBusy||runningSession.arenaPhase==='battle'||runningSession.arenaPhase==='finished',onClick:()=>{runningSession.arenaPicking=true;sessionController?.notify?.();}},'更换对手')),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h(WhaleWallet,{getService}),
              h('details', {className:'gc-runtime-info'},
              h('summary', {}, '运行信息'),
              h('div', {className:'gc-runtime-info-popover'},
              h('p', {}, `版本提交：${runningSession.commit.slice(0, 7)}`),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setFrameMode(frameMode === 'srcdoc' ? 'blob' : 'srcdoc'),
                  disabled: sessionSnapshot?.state === 'finalizing',
                  style: { ...BUTTON_STYLE, fontSize: '12px', padding: '3px 8px' },
                },
                `切换容器模式：${frameMode}`,
              ))),
              h(
                'button',
                {
                  type: 'button',
                  'data-gamecenter-action': 'back-to-list',
                  onClick: () => void close('back-to-list'),
                  disabled: phase === 'pausing',
                  style: BUTTON_STYLE,
                },
                '返回游戏库',
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
          // page 模式：容器只作**占位**（anchor），iframe 由控制器命令式创建并
          // 直属 document.body，用 CSS position:fixed 对齐到本占位元素。
          // 关键：全程不跨父节点移动 DOM，避免 iframe browsing context 被重建。
          isPage && sessionController !== null
            ? h('div', {
                ref: bindFrameSlot,
                'data-gamecenter-frame-slot': '',
                style: {
                  // 【铺满】占位随内容区伸展（父级已可伸展）；只留一个小的可用下限，
                  // 不再固定 420px，否则游戏永远是个小窗。
                  flex: '1 1 auto',
                  minHeight: 0, minWidth: 0,
                  border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
                  borderRadius: '8px',
                  background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
                  overflow: 'hidden',
                },
              })
            : h('iframe', {
                ref: iframeRef,
                'data-gamecenter-frame': '',
                sandbox: GAME_IFRAME_SANDBOX,
                srcdoc: frameMode === 'srcdoc' ? runningSession.docHtml : undefined,
                src: frameMode === 'blob' ? runningSession.blobUrl : undefined,
                style: {
                  width: '100%',
                  flex: '1 1 auto',
                  minHeight: '420px',
                  border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
                  borderRadius: '8px',
                  background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
                },
              }),
        ),

      runningSession?.gameId==='example.cat-arena'&&runningSession.arenaMode==='duel'&&(!runningSession.arenaOpponent||runningSession.arenaPicking)&&h(ArenaOpponentPicker,{
        session:runningSession,getService,onSelected:()=>{runningSession.arenaPicking=false;sessionController?.notify?.();},onExit:()=>void close('close'),
      }),

      // 1b. 收敛中/失败占位（page 模式）：iframe 已 park 到屏幕外继续跑保存，
      //     这里给玩家真实状态；**不卸载容器**，落盘未确认前 session 不清空。
      isPage &&
        sessionSnapshot !== null &&
        (sessionSnapshot.state === 'finalizing' || sessionSnapshot.state === 'failed') &&
        h(
          'div',
          {
            'data-gamecenter-finalizing': '',
            role: 'status',
            'aria-live': 'polite',
            style: {
              padding: '16px',
              border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
              fontSize: '14px',
            },
          },
          sessionSnapshot.state === 'finalizing'
            ? '正在保存并退出…（保存确认完成前不会关闭游戏）'
            : `运行状态未确认：${sessionSnapshot.message ?? '未知原因'}。游戏仍保持运行，可重试关闭。`,
        ),

      // 2. 游戏库列表（页面模式常驻，不依赖 Tab）
      !runningSession && h('div', {style:{overflow:'hidden', minHeight:0, flex:'1 1 auto'}}, catalogListNode),

      // 3. 链路诊断弹窗（page 模式）：由页面右上角按钮经 diagnosticsOpen prop 直接驱动。
      // 不读 overlay.open state——那是挂载时快照，外部 set(true) 不会同步过来（真实缺陷）。
      // 复用既有 RemoteDiagnostics 实现，不重写；游戏运行中不弹（避免遮挡对局）。
      diagnosticsOpen &&
        !runningSession &&
        h(DiagnosticsDialog, {
          t,
          remoteState,
          getService,
          makeNonce,
          runDiagnostics,
          onClose: () => onClosed(),
        }),
    );
  }

  if (!open) return null;

  const title = t('title');

  return h(
    'div',
    { 'data-gamecenter-overlay': '' },
    isPage
      ? null
      : h('div', {
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
        'aria-modal': isPage ? 'false' : 'true',
        'aria-label': title,
        'aria-busy': phase === 'pausing' ? 'true' : 'false',
        'data-gamecenter-dialog': '',
        'data-gamecenter-phase': phase,
        style: runningSession ? RUNNING_DIALOG_STYLE : DIALOG_STYLE,
      },
      // 头部标题与 Tab 切换（page 模式无 Tab：改由页面右上角按钮承担）
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
        h('h2', { id: 'gamecenter-title', style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, title),
        !runningSession &&
          !isPage &&
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

      phase === 'pausing' ? h('p', { 'aria-live': 'polite', style: { margin: '0 0 12px', color: 'var(--dsw-alias-state-info-primary, #0969da)' } }, t('pausing')) : null,
      notice !== null ? h('p', { role: 'status', style: { margin: '0 0 12px', color: 'var(--dsw-alias-label-primary, CanvasText)' } }, notice) : null,

      // 1. 运行中模式：受控 iframe 界面
      runningSession !== null &&
        h(
          'div',
          { 'data-gamecenter-game-active': '', className:'gc-runtime', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
                borderRadius: '8px',
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('span', { style: { fontWeight: 600 } }, runningSession.title),
              h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, GrayText)' } }, `commit: ${runningSession.commit.slice(0, 7)}`),
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
              background: 'var(--dsw-alias-bg-base, Canvas)',
            },
          }),
        ),

      // 2. 游戏库列表 Tab（仅在无运行游戏时可见）
      !runningSession &&
        activeTab === 'games' &&
        catalogListNode,

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
  background: 'var(--dsw-alias-bg-base, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
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
  background: 'var(--dsw-alias-bg-base, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
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
  background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  fontWeight: 600,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '13px',
});

import {saveFlashBeforeClose} from '../runtime/wallet-progress.js';
