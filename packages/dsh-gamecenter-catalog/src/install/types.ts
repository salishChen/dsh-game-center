import type { InstallPlan, ErrorCode } from '@dsh-gamecenter/protocol'

export interface BundleFileDescriptor {
  /** 相对游戏仓库根目录的标准路径（如 dist/index.html） */
  path: string
  /** 文件字节数 */
  size: number
  /** sha256:<64hex> */
  sha256: string
}

export interface InstallSourceFile {
  path: string
  content: Uint8Array | Buffer
  isSymlink?: boolean | undefined
}

export interface InstallSecurityLimits {
  maxSingleFileBytes?: number | undefined
  maxTotalBytes?: number | undefined
  maxFileCount?: number | undefined
}

/**
 * 安装结果上报钩子（阶段 3，契约 `/v1/reports`）。
 *
 * 全部可选、全部 fire-and-forget：实现方不得让上报失败影响安装结果，
 * 统计也永不参与安装判定。
 */
export interface InstallReporter {
  downloadStarted?(): void
  installSucceeded?(): void
  downloadFailed?: (detail?: unknown) => void
  installFailed?(): void
}

export interface InstallOptions {
  plan: InstallPlan
  packagesDir: string
  stagingDir: string
  files: readonly InstallSourceFile[]
  manifestContent: string | Uint8Array | Buffer
  limits?: InstallSecurityLimits | undefined
  /** 可选上报钩子；缺省时安装行为完全不变。 */
  reporter?: InstallReporter | undefined
}

export type InstallResult =
  | {
      ok: true
      alreadyInstalled: boolean
      installedPath: string
      gameId: string
      commit: string
    }
  | {
      ok: false
      code: ErrorCode
      reason: string
    }
