import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { AppIcon, AppSummary } from '@solus/contracts/apps'

type IconApp = Pick<AppSummary, 'id' | 'iconHash'>

interface KeptIcon {
  hash: string
  svg: string
  /** The icon as an image address, made once for each hash. */
  url: string
}

function iconKey(serverId: string, appId: string): string {
  return `${serverId}\n${appId}`
}

/** An SVG as an image address. An image runs no script and loads nothing outside it, so the icon is safe to show as it is. */
export function svgImageUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * The icons of the apps (docs/app-shortcuts.md §4) on desktop and web: each
 * icon is read once for each hash that `AppSummary.iconHash` names, and kept.
 * An app with no hash, an icon that is still on its way, and a read that
 * failed all give null, and the tile shows the monogram.
 */
export class AppIconsStore {
  private readonly icons = new SvelteMap<string, KeptIcon>()
  /** The hash each read in progress is for, so one hash is read once. */
  private readonly reads = new Map<string, Promise<KeptIcon | null>>()

  constructor(
    private readonly readIcon: (serverId: string, appId: string) => Promise<AppIcon | null> =
      (serverId, appId) => serverConnections.apiFor(serverId).appIcon({ appId }),
  ) {}

  /**
   * The app's icon as an image address; null when the app has none and while
   * the first read of it is on its way. A new hash keeps the old icon on
   * screen until the new one arrives.
   */
  urlFor(serverId: string, app: IconApp): string | null {
    if (!app.iconHash) return null
    const kept = this.icons.get(iconKey(serverId, app.id))
    if (kept?.hash !== app.iconHash) void this.load(serverId, app.id, app.iconHash)
    return kept?.url ?? null
  }

  /** The SVG of the app's icon for its hash, read when it is not kept; null when the app has none or the read failed. */
  async svgFor(serverId: string, app: IconApp): Promise<string | null> {
    if (!app.iconHash) return null
    return (await this.load(serverId, app.id, app.iconHash))?.svg ?? null
  }

  private load(serverId: string, appId: string, hash: string): Promise<KeptIcon | null> {
    const key = iconKey(serverId, appId)
    const kept = this.icons.get(key)
    if (kept?.hash === hash) return Promise.resolve(kept)
    const readKey = `${key}\n${hash}`
    const inFlight = this.reads.get(readKey)
    if (inFlight) return inFlight
    const read = this.readIcon(serverId, appId).then(
      (icon) => {
        // The host answers for its active version now, which a deploy can have moved past `hash`.
        if (!icon) return null
        const next = { hash: icon.hash, svg: icon.svg, url: svgImageUrl(icon.svg) }
        this.icons.set(key, next)
        return next.hash === hash ? next : null
      },
      () => null,
    ).finally(() => this.reads.delete(readKey))
    this.reads.set(readKey, read)
    return read
  }
}

export const appIconsStore = new AppIconsStore()
