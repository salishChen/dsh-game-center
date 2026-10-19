/**
 * 运行时资源清理表（基线 §7 末尾、§8.1 第 5 步）。
 *
 * 游戏的所有 Worker、音频、动画帧、定时器、事件监听、订阅、MessagePort
 * 都必须登记到这里；销毁时按**注册逆序**释放一次，重复调用是幂等的。
 * 这不是 DSH API，是游戏中心自己的资源账本。
 */
/** @typedef {(kind: string) => void} Releaser */
/** @typedef {'iframe'|'worker'|'audio'|'raf'|'timer'|'listener'|'subscription'|'port'} ResourceKind */
/**
 * @typedef {object} ResourceTable
 * @property {(kind: ResourceKind, dispose: () => void) => () => void} track
 * @property {() => {released: number, kinds: Record<string, number>, errors: string[]}} releaseAll
 * @property {() => {count: number, kinds: Record<string, number>}} outstanding
 * @property {boolean} disposed
 */
/** @returns {ResourceTable} */
export function createResourceTable(): ResourceTable;
export type Releaser = (kind: string) => void;
export type ResourceKind = "iframe" | "worker" | "audio" | "raf" | "timer" | "listener" | "subscription" | "port";
export type ResourceTable = {
    track: (kind: ResourceKind, dispose: () => void) => () => void;
    releaseAll: () => {
        released: number;
        kinds: Record<string, number>;
        errors: string[];
    };
    outstanding: () => {
        count: number;
        kinds: Record<string, number>;
    };
    disposed: boolean;
};
