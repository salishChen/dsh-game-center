/**
 * 判断相对路径是否安全且在白名单内。
 * @param {string} p
 * @returns {boolean}
 */
export function isSafeBundlePath(p: string): boolean;
/**
 * 校验 bundle 文件清单是否符合安全规范。
 * @param {any[]} files
 * @returns {{field: string, reason: string}[]}
 */
export function validateGameBundleFiles(files: any[]): {
    field: string;
    reason: string;
}[];
/**
 * 校验沙箱与 CSP 策略是否满足安全隔离红线。
 * @param {string} sandbox
 * @param {string} csp
 * @returns {{field: string, reason: string}[]}
 */
export function validateFramePolicy(sandbox: string, csp: string): {
    field: string;
    reason: string;
}[];
/**
 * 生成在 iframe 内先于游戏运行的轻量 SDK 引导脚本。
 * @param {object} options
 * @param {string} options.runtimeInstanceId
 * @param {string} options.nonce
 * @param {string | number} [options.initialSeed]
 * @param {string} [options.initialRngState]
 * @param {number} [options.initialElapsedMs]
 * @param {number} [options.initialRevision]
 * @returns {string}
 */
export function generateSdkBootstrapSource(options: {
    runtimeInstanceId: string;
    nonce: string;
    initialSeed?: string | number | undefined;
    initialRngState?: string | undefined;
    initialElapsedMs?: number | undefined;
    initialRevision?: number | undefined;
}): string;
/**
 * 校验 CSS 内容：严禁 at-import 和非 data: 的 url() 外部引用。
 * @param {string} css
 * @param {string} sourceName
 */
export function validateCssContent(css: string, sourceName: string): void;
/**
 * 校验 HTML 结构与标签白名单策略。
 * @param {string} html
 */
export function validateHtmlSecurity(html: string): void;
/**
 * 组装完全内联化的受限游戏 iframe 文档。
 *
 * @param {object} params
 * @param {string} params.entryPath 游戏入口路径（例如 "dist/index.html" 或 "index.html"）
 * @param {Array<{path: string, content: string}>} params.files 游戏包文件列表
 * @param {object} params.options 运行实例参数
 * @param {string} params.options.runtimeInstanceId
 * @param {string} params.options.nonce
 * @param {string | number} [params.options.initialSeed]
 * @param {string} [params.options.initialRngState]
 * @param {number} [params.options.initialElapsedMs]
 * @param {number} [params.options.initialRevision]
 * @returns {string} 组装完成的单文档 HTML
 */
export function assembleGameDocument({ entryPath, files, options }: {
    entryPath: string;
    files: Array<{
        path: string;
        content: string;
    }>;
    options: {
        runtimeInstanceId: string;
        nonce: string;
        initialSeed?: string | number | undefined;
        initialRngState?: string | undefined;
        initialElapsedMs?: number | undefined;
        initialRevision?: number | undefined;
    };
}): string;
export const GAME_IFRAME_SANDBOX: "allow-scripts";
export const GAME_DOCUMENT_CSP: "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
export const GAME_BUNDLE_MAX_FILES: 64;
export const GAME_BUNDLE_MAX_FILE_BYTES: number;
export const GAME_BUNDLE_MAX_TOTAL_BYTES: number;
export const GAME_BUNDLE_MAX_PATH_LENGTH: 256;
export const GAME_BUNDLE_TEXT_EXTENSIONS: readonly string[];
