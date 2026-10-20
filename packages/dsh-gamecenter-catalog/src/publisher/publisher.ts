import {
  parseCatalogIssueBody,
  type CatalogMachineEntry,
} from '@dsh-gamecenter/protocol'
import { calculateManifestDigest, calculateBundleDigest } from '../install/bundleDigest.js'
import type { InstallSourceFile } from '../install/types.js'

export interface PublishInput {
  gameId: string
  title: string
  summary: string
  version: string
  repository: string
  ref: string
  commit: string
  manifestPath?: string | undefined
  manifestContent: string | Uint8Array | Buffer
  distFiles: readonly InstallSourceFile[]
}

export interface PublishResult {
  manifestDigest: string
  bundleDigest: string
  machineEntry: CatalogMachineEntry
  issueBody: string
}

/**
 * 开发者发布辅助工具：
 * 从游戏仓库固定提交生成规范摘要，并构造符合目录规范的 Issue 正文。
 */
export function generatePublishIssueBody(input: PublishInput): PublishResult {
  const manifestPath = input.manifestPath ?? 'gamecenter.json'
  const manifestDigest = calculateManifestDigest(input.manifestContent)
  const { bundleDigest } = calculateBundleDigest(input.distFiles)

  const machineEntry: CatalogMachineEntry = {
    schemaVersion: 1,
    gameId: input.gameId,
    title: input.title,
    summary: input.summary,
    version: input.version,
    source: {
      repository: input.repository,
      ref: input.ref,
      commit: input.commit,
      manifestPath,
      manifestDigest,
      bundleDigest,
    },
  }

  const jsonText = JSON.stringify(machineEntry, null, 2)

  const issueBody = `<!-- dsh-gamecenter-entry:v1 -->
# ${input.title}

${input.summary}

\`\`\`gamecenter-json
${jsonText}
\`\`\`
`

  // 严格自检：产出的 issueBody 必须能被官方 parser 解析通过
  const parsed = parseCatalogIssueBody(issueBody)
  if (!parsed.ok) {
    throw new Error(`发布工具生成的 Issue 正文未通过自测校验: ${parsed.reason}`)
  }

  return {
    manifestDigest,
    bundleDigest,
    machineEntry,
    issueBody,
  }
}
