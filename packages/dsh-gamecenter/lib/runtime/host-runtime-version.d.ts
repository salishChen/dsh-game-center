/**
 * Host 运行版本解析器（阶段1，2026-10-20 冻结）。
 *
 * 依据 docs/phase1-runtime-version-wiring.md：
 * 1. DSH 运行版本 (running.dsh)：
 *    唯一来源 = 当前进程接收的运行时目录 process.argv[2]（由 dsh-desktop-host L220 消费）。
 *    读取并交叉比对 <runtimeDir>/desktop-runtime.json 的 release.version 与 <runtimeDir>/package.json 的 version。
 *    两者必须相等且为合法 SemVer，证据标记为 processBound (boundToRunningProcess=true)。
 * 2. 游戏中心平台版本 (running.gameCenter)：
 *    唯一来源 = Host 包自身 package.json 的 version（从 import.meta.url 相对路径读取）。
 *    必须为合法三段 SemVer（标准定为 1.0.0）。
 * 3. 任何一处失败、证据不全、版本不一致一律返回 null (fail closed)。
 */
import { type RuntimeVersionObservation, type RunningVersionPair } from '@dsh-gamecenter/protocol';
export interface HostRuntimeVersionResult {
    ok: boolean;
    runningVersions: {
        gameCenter: string;
        dsh: string;
    } | null;
    pair?: RunningVersionPair;
    error?: string;
}
/**
 * 从 argv[2] 解析当前运行中的 DSH 宿主版本观测。
 */
export declare function resolveDshProcessObservation(argv?: readonly string[], nowIso?: string): RuntimeVersionObservation | null;
/**
 * 从 Host package.json 读取当前游戏中心平台版本观测。
 */
export declare function resolveGameCenterPackageObservation(moduleUrl?: string, nowIso?: string): RuntimeVersionObservation | null;
/**
 * 统一解析 Host 侧权威运行版本。任一失败即返回 null。
 */
export declare function resolveHostRuntimeVersions(argv?: readonly string[], moduleUrl?: string, nowIso?: string): {
    gameCenter: string;
    dsh: string;
} | null;
