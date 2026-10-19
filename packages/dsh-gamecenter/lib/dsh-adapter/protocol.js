/**
 * `@deepseek-ai/dsh-typert-protocol` 的加载适配层。
 *
 * 实装事实（0.2.1-rc.2 / 332895e0…）：
 * - 该包是 Host 侧 peer 依赖（`peerDependencies: { "@deepseek-ai/dsh-typert-protocol": "0.2.1-rc.2" }`，
 *   见 `dsh-host-plugin-inventory/package.json`）。
 * - 它由 DSH 进程的模块解析提供，**不在本项目 node_modules 中**；
 *   因此 import 必须失败可恢复（探针要如实报告「未装载」而不是崩溃）。
 * - `@Remote` 必须由**同一个**协议副本执行，否则 `remoteMethods()` 读到的原型标记
 *   版本校验可能不一致。所以这里只允许从 DSH 运行时解析，不在项目内 vendor 第二份。
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
const MODULE_ID = '@deepseek-ai/dsh-typert-protocol';
/**
 * 异步探测：只用于探针/自检。
 * @returns 协议模块，或 null（附失败原因由调用方记录）。
 */
export async function probeProtocol() {
    try {
        const loaded = await import(__rewriteRelativeImportExtension(MODULE_ID));
        const module = loaded;
        if (typeof module.Remote !== 'function' || typeof module.TypertRemoteService !== 'function') {
            return { ok: false, error: `${MODULE_ID} 存在但缺少 Remote / TypertRemoteService 导出` };
        }
        if (typeof module.remoteMethods !== 'function') {
            return { ok: false, error: `${MODULE_ID} 缺少 remoteMethods 导出` };
        }
        return { ok: true, module };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
}
/**
 * 本包在 Host 侧的真名空间。**这是本项目拟新增协议**，DSH 中不存在该名字。
 * Client 侧 `ctx.remote.gameCenter` 即此命名空间。
 */
export const REMOTE_NAMESPACE = 'gameCenter';
/**
 * Cordis 服务键。为避免与 DSH 既有服务键冲突，使用项目前缀。
 */
export const SERVICE_KEY = 'gameCenter';
//# sourceMappingURL=protocol.js.map