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

export interface InstallOptions {
  plan: InstallPlan
  packagesDir: string
  stagingDir: string
  files: readonly InstallSourceFile[]
  manifestContent: string | Uint8Array | Buffer
  limits?: InstallSecurityLimits | undefined
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
