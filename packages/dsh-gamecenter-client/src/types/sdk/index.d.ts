/**
 * @typedef {object} GameMessage
 * @property {'system' | 'user' | 'assistant'} role
 * @property {string} text
 * @property {string[]} [assetIds]
 */
/**
 * @typedef {object} AiGenerateRequest
 * @property {string} slot
 * @property {string} [operation]
 * @property {string} operationId 幂等操作 ID
 * @property {GameMessage[]} messages
 * @property {Record<string, unknown>} [responseSchema]
 */
/**
 * @typedef {object} LifecycleHooks
 * @property {() => Promise<unknown> | unknown} pause
 * @property {(snapshot: unknown) => Promise<void> | void} [restore]
 * @property {() => Promise<void> | void} [resume]
 */
/**
 * 创建小游戏 SDK 实例。
 *
 * @param {object} options
 * @param {MessagePort} options.port 专用的双向通信 MessagePort
 * @param {string | number} [options.initialSeed] 初始伪随机数种子
 * @param {string} [options.initialRngState] 恢复运行时的已有伪随机数状态（优先于 initialSeed）
 * @param {number} [options.initialElapsedMs] 初始累计游戏毫秒
 * @param {number} [options.initialRevision] 恢复运行时已有的基准 revision（作为后续 checkpoint 的 expectedRevision）
 */
export function createGameCenterSDK(options: {
    port: MessagePort;
    initialSeed?: string | number | undefined;
    initialRngState?: string | undefined;
    initialElapsedMs?: number | undefined;
    initialRevision?: number | undefined;
}): {
    ai: {
        /**
         * 请求 AI 生成（阶段1返回 fixture 数据，禁止真实付费调用）。
         * @param {AiGenerateRequest} request
         * @returns {Promise<any>}
         */
        generate(request: AiGenerateRequest): Promise<any>;
        /**
         * 取消进行中的 AI 操作。
         * @param {{ operationId: string }} request
         */
        cancel(request: {
            operationId: string;
        }): Promise<any>;
    };
    save: {
        /**
         * 请求保存检查点。
         *
         * 契约（packages/protocol/src/checkpoint.ts `CheckpointRequest`）：
         * - `operationId`：本次保存动作的幂等键。重试必须复用同一个值；不同动作同状态产生不同 ID。
         * - `expectedRevision`：调用方期望的基准 revision，首次传 0 或初始 revision，
         *   之后传上次成功返回的 revision；不匹配时宿主返回 STALE_RUNTIME。
         * - `retry`：布尔值，指定为 true 时表示重试上一次失败的保存动作，自动复用上一次的 operationId 与 expectedRevision。
         *
         * @param {unknown} gameState 游戏不透明状态
         * @param {{ operationId?: string, expectedRevision?: number, retry?: boolean, isRetry?: boolean }} [opts]
         * @returns {Promise<{ revision: number, idempotentReplay?: boolean, operationId: string }>}
         */
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
        /**
         * 通知平台游戏已加载完成并准备就绪。
         * 宿主收到后解锁时钟与输入。
         */
        ready(): Promise<any>;
        /**
         * 注册小游戏自身的暂停与恢复钩子。
         * @param {LifecycleHooks} hooks
         */
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
        /**
         * 资产安全引用解析（游戏只能引用自身包内的相对路径或资产 ID）。
         * @param {string} assetId
         * @returns {string}
         */
        resolve(assetId: string): string;
    };
};
/**
 * 创建 SDK 并返回 `{ sdk, dispose }`。
 *
 * 为什么把 dispose 与 sdk 分开：SDK 表面是**游戏可见的白名单**（ai/save/lifecycle/clock/
 * random/assets），`dispose` 属于宿主侧生命周期管理，不能混进白名单对象，
 * 否则"仅暴露受限能力"的安全断言会被破坏，游戏也可能自己调用 dispose 干扰宿主。
 *
 * @param {{ port: MessagePort, initialSeed?: string | number, initialRngState?: string, initialElapsedMs?: number, initialRevision?: number }} options
 */
export function createGameCenterSDKWithDispose(options: {
    port: MessagePort;
    initialSeed?: string | number;
    initialRngState?: string;
    initialElapsedMs?: number;
    initialRevision?: number;
}): {
    sdk: {
        ai: {
            /**
             * 请求 AI 生成（阶段1返回 fixture 数据，禁止真实付费调用）。
             * @param {AiGenerateRequest} request
             * @returns {Promise<any>}
             */
            generate(request: AiGenerateRequest): Promise<any>;
            /**
             * 取消进行中的 AI 操作。
             * @param {{ operationId: string }} request
             */
            cancel(request: {
                operationId: string;
            }): Promise<any>;
        };
        save: {
            /**
             * 请求保存检查点。
             *
             * 契约（packages/protocol/src/checkpoint.ts `CheckpointRequest`）：
             * - `operationId`：本次保存动作的幂等键。重试必须复用同一个值；不同动作同状态产生不同 ID。
             * - `expectedRevision`：调用方期望的基准 revision，首次传 0 或初始 revision，
             *   之后传上次成功返回的 revision；不匹配时宿主返回 STALE_RUNTIME。
             * - `retry`：布尔值，指定为 true 时表示重试上一次失败的保存动作，自动复用上一次的 operationId 与 expectedRevision。
             *
             * @param {unknown} gameState 游戏不透明状态
             * @param {{ operationId?: string, expectedRevision?: number, retry?: boolean, isRetry?: boolean }} [opts]
             * @returns {Promise<{ revision: number, idempotentReplay?: boolean, operationId: string }>}
             */
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
            /**
             * 通知平台游戏已加载完成并准备就绪。
             * 宿主收到后解锁时钟与输入。
             */
            ready(): Promise<any>;
            /**
             * 注册小游戏自身的暂停与恢复钩子。
             * @param {LifecycleHooks} hooks
             */
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
            /**
             * 资产安全引用解析（游戏只能引用自身包内的相对路径或资产 ID）。
             * @param {string} assetId
             * @returns {string}
             */
            resolve(assetId: string): string;
        };
    };
    dispose: () => void;
};
/**
 * 无显式 operationId 时，由「状态内容 + 虚拟时间 + RNG」派生一个稳定 ID。
 *
 * 目的：同一状态的重试必须得到同一个 ID（否则重试会被当成新动作，多写一条检查点），
 * 而不同状态必须得到不同 ID。用 JSON 的稳定哈希即可，不需要密码学强度——
 * 它只是幂等键的一部分，真正防篡改靠宿主的摘要与审批。
 *
 * @param {unknown} state
 * @param {number} elapsedGameMs
 * @param {string} rngState
 * @returns {string}
 */
export function computeAutoOperationId(state: unknown, elapsedGameMs: number, rngState: string): string;
export { createSeededRandom } from "./random.js";
export { createGameClock } from "./clock.js";
export type GameMessage = {
    role: "system" | "user" | "assistant";
    text: string;
    assetIds?: string[];
};
export type AiGenerateRequest = {
    slot: string;
    operation?: string;
    /**
     * 幂等操作 ID
     */
    operationId: string;
    messages: GameMessage[];
    responseSchema?: Record<string, unknown>;
};
export type LifecycleHooks = {
    pause: () => Promise<unknown> | unknown;
    restore?: (snapshot: unknown) => Promise<void> | void;
    resume?: () => Promise<void> | void;
};
