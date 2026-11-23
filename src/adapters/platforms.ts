import type { PlatformDescriptor, PlatformId } from './types'

/**
 * Catalog of platforms shown in the UI. Only "available" platforms with a
 * registered adapter can be used to create bots; the rest render as
 * "coming soon".
 *
 * Fork note (Liberniz): this fork is Muse-only. The other platforms were
 * removed from the catalog so they cannot be added or used; their adapter
 * code remains in the tree but is never registered (see adapters/index.ts).
 */
export const PLATFORMS: readonly PlatformDescriptor[] = [
  {
    id: 'meta-muse',
    name: 'Meta Muse',
    description: 'Meta 个人智能体 · 对话、连接器与安全审批',
    availability: 'available',
    monogram: 'M',
    homeUrl: 'https://muse.ai'
  }
]

export function getPlatform(id: PlatformId): PlatformDescriptor {
  const platform = PLATFORMS.find((p) => p.id === id)
  if (!platform) throw new Error(`Unknown platform: ${id}`)
  return platform
}
