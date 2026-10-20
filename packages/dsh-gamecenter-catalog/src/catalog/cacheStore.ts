import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CatalogCacheSnapshot, ICatalogCacheStore, CatalogEntryView } from './types.js'

export class MemoryCatalogCacheStore implements ICatalogCacheStore {
  private snapshot: CatalogCacheSnapshot | null = null

  async load(): Promise<CatalogCacheSnapshot | null> {
    if (!this.snapshot) return null
    return JSON.parse(JSON.stringify(this.snapshot))
  }

  async save(snapshot: CatalogCacheSnapshot): Promise<void> {
    this.snapshot = JSON.parse(JSON.stringify(snapshot))
  }
}

export class FileCatalogCacheStore implements ICatalogCacheStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<CatalogCacheSnapshot | null> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (parsed && Array.isArray(parsed.entries)) {
        return parsed as CatalogCacheSnapshot
      }
      return null
    } catch {
      return null
    }
  }

  async save(snapshot: CatalogCacheSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8')
    await fs.rename(tmpPath, this.filePath)
  }
}

/**
 * 离线安全合并：在网络增量同步失败时，保留全部旧缓存条目；
 * 同步成功时，根据增量或全量对账合并新旧条目。
 */
export function mergeCatalogEntries(
  existing: readonly CatalogEntryView[],
  incoming: readonly CatalogEntryView[],
  removedKeys: readonly string[] = [],
): CatalogEntryView[] {
  const map = new Map<string, CatalogEntryView>()
  for (const entry of existing) {
    const keyStr = `${entry.key.forge}:${entry.key.owner}/${entry.key.repo}#${entry.key.issueId}`
    map.set(keyStr, entry)
  }

  for (const entry of incoming) {
    const keyStr = `${entry.key.forge}:${entry.key.owner}/${entry.key.repo}#${entry.key.issueId}`
    map.set(keyStr, entry)
  }

  for (const key of removedKeys) {
    map.delete(key)
  }

  return Array.from(map.values())
}
