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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemver, resolveRunningVersions, } from '@dsh-gamecenter/protocol';
/**
 * 从 argv[2] 解析当前运行中的 DSH 宿主版本观测。
 */
export function resolveDshProcessObservation(argv = process.argv, nowIso = new Date().toISOString()) {
    const runtimeDir = argv[2];
    if (typeof runtimeDir !== 'string' || runtimeDir.trim().length === 0) {
        return null;
    }
    const resolvedRuntimeDir = path.resolve(runtimeDir);
    try {
        const dtrPath = path.join(resolvedRuntimeDir, 'desktop-runtime.json');
        const pkgPath = path.join(resolvedRuntimeDir, 'package.json');
        const dtrRaw = fs.readFileSync(dtrPath, 'utf8');
        const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
        const dtr = JSON.parse(dtrRaw);
        const pkg = JSON.parse(pkgRaw);
        // 强校验包名身份，防止伪造任意 argv[2] 路径
        if (pkg?.name !== '@deepseek-ai/dsh-desktop-runtime') {
            return null;
        }
        const dtrVersion = typeof dtr?.release?.version === 'string' ? dtr.release.version.trim() : null;
        const pkgVersion = typeof pkg?.version === 'string' ? pkg.version.trim() : null;
        if (!dtrVersion || !pkgVersion) {
            return null;
        }
        if (dtrVersion !== pkgVersion) {
            return null;
        }
        if (!parseSemver(dtrVersion)) {
            return null;
        }
        return {
            platform: 'dsh',
            raw: dtrVersion,
            evidence: 'processBound',
            boundToRunningProcess: true,
            source: dtrPath,
            observedAt: nowIso,
            details: {
                runtimeDir: resolvedRuntimeDir,
            },
        };
    }
    catch {
        return null;
    }
}
/**
 * 从 Host package.json 读取当前游戏中心平台版本观测。
 */
export function resolveGameCenterPackageObservation(moduleUrl = import.meta.url, nowIso = new Date().toISOString()) {
    try {
        const currentFilePath = fileURLToPath(moduleUrl);
        // 源码在 src/runtime/ 或 staging/runtime/ 下，package.json 在两级上层
        const pkgPath = path.resolve(path.dirname(currentFilePath), '../../package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw);
        // 强校验包名身份，防止从非 Host 包的 package.json 伪造平台版本
        if (pkg?.name !== '@dsh-gamecenter/host') {
            return null;
        }
        const version = typeof pkg?.version === 'string' ? pkg.version.trim() : null;
        if (!version || !parseSemver(version)) {
            return null;
        }
        return {
            platform: 'gamecenter',
            raw: version,
            evidence: 'processBound',
            boundToRunningProcess: true,
            source: pkgPath,
            observedAt: nowIso,
            details: {
                packageName: String(pkg?.name ?? ''),
            },
        };
    }
    catch {
        return null;
    }
}
/**
 * 统一解析 Host 侧权威运行版本。任一失败即返回 null。
 */
export function resolveHostRuntimeVersions(argv = process.argv, moduleUrl = import.meta.url, nowIso = new Date().toISOString()) {
    const dshObs = resolveDshProcessObservation(argv, nowIso);
    const gcObs = resolveGameCenterPackageObservation(moduleUrl, nowIso);
    const resolved = resolveRunningVersions(gcObs, dshObs);
    if (!resolved.ok) {
        return null;
    }
    return {
        gameCenter: resolved.pair.gameCenter,
        dsh: resolved.pair.dsh,
    };
}
//# sourceMappingURL=host-runtime-version.js.map