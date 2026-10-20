/**
 * @typedef {object} BridgeDispatcherOptions
 * @property {import('../runtime/lease.js').RuntimeLease} lease 运行实例租约
 * @property {MessagePort} [port] 通信端口（可选，若未提供可在 bindPort 后生效）
 * @property {readonly string[]} [allowedMethods] 允许的方法白名单（默认 BRIDGE_METHODS）
 * @property {ReturnType<typeof createRateLimiter>} [rateLimiter] 频率限制器
 * @property {(payload: any) => Promise<any> | any} [onAiGenerate] 处理 AI 生成（阶段1用 fixture）
 * @property {(payload: any) => Promise<any> | any} [onAiCancel] 处理 AI 取消
 * @property {(payload: any) => Promise<any> | any} [onCheckpoint] 处理存档检查点
 * @property {string} [playerId] 宿主绑定的玩家身份（由 Host 注入，绝不取游戏自报值）
 * @property {(payload: any) => Promise<void> | void} [onReady] 处理准备就绪
 * @property {(payload: any) => Promise<void> | void} [onPauseAck] 处理暂停确认
 */
/**
 * 创建 Bridge 请求分发器。
 * @param {BridgeDispatcherOptions} options
 */
export function createBridgeDispatcher(options: BridgeDispatcherOptions): {
    bindPort: (port: MessagePort) => void;
    handleMessage: (rawData: unknown) => Promise<void>;
    triggerPause: ({ reason }: {
        reason: string;
    }) => boolean;
    dispose: () => void;
};
/**
 * @typedef {object} ConnectSDKToDispatcherOptions
 * @property {import('../runtime/lease.js').RuntimeLease} lease 运行实例租约
 * @property {string} playerId 宿主可信玩家身份
 * @property {string | number} [initialSeed] 初始随机数种子
 * @property {string} [initialRngState] 恢复时已有的随机数状态
 * @property {number} [initialElapsedMs] 初始累计游戏毫秒
 * @property {number} [initialRevision] 恢复时已有的基准 revision
 * @property {(payload: any) => Promise<{ ok?: boolean, revision?: number, idempotentReplay?: boolean, code?: string, message?: string }> | any} onCheckpoint 存档检查点处理回调（可直连 SaveStore.writeCheckpoint）
 * @property {(payload: any) => Promise<any> | any} [onAiGenerate] 处理 AI 生成
 * @property {(payload: any) => Promise<any> | any} [onAiCancel] 处理 AI 取消
 * @property {(payload: any) => Promise<void> | void} [onReady] 处理准备就绪
 * @property {(payload: any) => Promise<void> | void} [onPauseAck] 处理暂停确认
 */
/**
 * 建立专用双向 MessageChannel，将 SDK 实例与 BridgeDispatcher 无缝直连。
 * 驱动真实 MessagePort 链路：SDK.save.checkpoint -> dispatcher -> 宿主存储 -> SDK 回执。
 * 提供生命周期安全清理（dispose），确保在 Node 与浏览器下端口、监听器与计时器完全释放。
 *
 * @param {ConnectSDKToDispatcherOptions} options
 */
export function connectSDKToDispatcher(options: ConnectSDKToDispatcherOptions): {
    sdk: {
        ai: {
            generate(request: AiGenerateRequest): Promise<any>;
            cancel(request: {
                operationId: string;
            }): Promise<any>;
        };
        save: {
            checkpoint(gameState: unknown, opts?: {
                operationId?: string;
                expectedRevision?: number;
                retry?: boolean;
                isRetry?: boolean;
            }): Promise<{
                revision: number;
                idempotentReplay?: boolean;
                operationId: string;
            }>;
        };
        lifecycle: {
            ready(): Promise<any>;
            register(hooks: LifecycleHooks): void;
        };
        clock: {
            resume: () => void;
            pause: () => void;
            getElapsedMs: () => number;
            isClockFrozen: () => boolean;
            reset: (newElapsedMs?: number) => void;
        };
        random: {
            next: () => number;
            nextInt: (min: number, max: number) => number;
            getState: () => string;
            setState: (stateStr: string) => void;
        };
        assets: {
            resolve(assetId: string): string;
        };
    };
    dispatcher: {
        bindPort: (port: MessagePort) => void;
        handleMessage: (rawData: unknown) => Promise<void>;
        triggerPause: ({ reason }: {
            reason: string;
        }) => boolean;
        dispose: () => void;
    };
    port1: MessagePort;
    port2: MessagePort;
    dispose: () => void;
};
export type BridgeDispatcherOptions = {
    /**
     * 运行实例租约
     */
    lease: import("../runtime/lease.js").RuntimeLease;
    /**
     * 通信端口（可选，若未提供可在 bindPort 后生效）
     */
    port?: MessagePort;
    /**
     * 允许的方法白名单（默认 BRIDGE_METHODS）
     */
    allowedMethods?: readonly string[];
    /**
     * 频率限制器
     */
    rateLimiter?: ReturnType<typeof createRateLimiter>;
    /**
     * 处理 AI 生成（阶段1用 fixture）
     */
    onAiGenerate?: (payload: any) => Promise<any> | any;
    /**
     * 处理 AI 取消
     */
    onAiCancel?: (payload: any) => Promise<any> | any;
    /**
     * 处理存档检查点
     */
    onCheckpoint?: (payload: any) => Promise<any> | any;
    /**
     * 宿主绑定的玩家身份（由 Host 注入，绝不取游戏自报值）
     */
    playerId?: string;
    /**
     * 处理准备就绪
     */
    onReady?: (payload: any) => Promise<void> | void;
    /**
     * 处理暂停确认
     */
    onPauseAck?: (payload: any) => Promise<void> | void;
};
export type ConnectSDKToDispatcherOptions = {
    /**
     * 运行实例租约
     */
    lease: import("../runtime/lease.js").RuntimeLease;
    /**
     * 宿主可信玩家身份
     */
    playerId: string;
    /**
     * 初始随机数种子
     */
    initialSeed?: string | number;
    /**
     * 恢复时已有的随机数状态
     */
    initialRngState?: string;
    /**
     * 初始累计游戏毫秒
     */
    initialElapsedMs?: number;
    /**
     * 恢复时已有的基准 revision
     */
    initialRevision?: number;
    /**
     * 存档检查点处理回调（可直连 SaveStore.writeCheckpoint）
     */
    onCheckpoint: (payload: any) => Promise<{
        ok?: boolean;
        revision?: number;
        idempotentReplay?: boolean;
        code?: string;
        message?: string;
    }> | any;
    /**
     * 处理 AI 生成
     */
    onAiGenerate?: (payload: any) => Promise<any> | any;
    /**
     * 处理 AI 取消
     */
    onAiCancel?: (payload: any) => Promise<any> | any;
    /**
     * 处理准备就绪
     */
    onReady?: (payload: any) => Promise<void> | void;
    /**
     * 处理暂停确认
     */
    onPauseAck?: (payload: any) => Promise<void> | void;
};
import { createRateLimiter } from './host-bridge.js';
