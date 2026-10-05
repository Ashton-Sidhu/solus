import { z } from 'zod'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'

/**
 * What one client remembers about a session's device tabs: which preview is
 * selected and the names the user gave them. A rename changes the tab label
 * only, never the simulator's own name. The host owns which previews exist,
 * so nothing here can reopen a closed one.
 */

interface SessionDeviceView {
  selectedPreviewId: string | null
  names: { [devicePreviewId: string]: string }
}

const STORAGE_KEY = 'solus:device-view:v1'
const MAX_SESSIONS = 200

function viewKey(serverId: string, sessionId: string): string {
  return `${serverId}\u0000${sessionId}`
}

const storedViewsSchema = z.array(z.tuple([
  z.string().max(400),
  z.object({
    selectedPreviewId: z.string().max(200).nullable().catch(null),
    names: z.record(z.string().max(200), z.string().max(80)).catch({}),
  }),
])).max(MAX_SESSIONS)

function readStorage(): Map<string, SessionDeviceView> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = storedViewsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? new Map(parsed.data) : new Map()
  } catch {
    return new Map()
  }
}

export class DeviceViewState {
  private readonly views = new SvelteMap<string, SessionDeviceView>(readStorage())
  /** Hosts whose Devices pane shows Builds. Not stored: a new window starts on the devices. */
  private readonly buildsShown = new SvelteSet<string>()

  isShowingBuilds(serverId: string): boolean {
    return this.buildsShown.has(serverId)
  }

  showBuilds(serverId: string, shown: boolean): void {
    if (shown) this.buildsShown.add(serverId)
    else this.buildsShown.delete(serverId)
  }

  selected(serverId: string, sessionId: string): string | null {
    return this.views.get(viewKey(serverId, sessionId))?.selectedPreviewId ?? null
  }

  name(serverId: string, sessionId: string, devicePreviewId: string): string | undefined {
    return this.views.get(viewKey(serverId, sessionId))?.names[devicePreviewId]
  }

  select(serverId: string, sessionId: string, devicePreviewId: string): void {
    const view = this.views.get(viewKey(serverId, sessionId))
    if (view?.selectedPreviewId === devicePreviewId) return
    this.views.set(viewKey(serverId, sessionId), { selectedPreviewId: devicePreviewId, names: view?.names ?? {} })
    this.persist()
  }

  rename(serverId: string, sessionId: string, devicePreviewId: string, name: string): void {
    const view = this.views.get(viewKey(serverId, sessionId)) ?? { selectedPreviewId: null, names: {} }
    const names = { ...view.names }
    const trimmed = name.trim().slice(0, 80)
    if (trimmed) names[devicePreviewId] = trimmed
    else delete names[devicePreviewId]
    this.views.set(viewKey(serverId, sessionId), { ...view, names })
    this.persist()
  }

  private persist(): void {
    try {
      const entries = [...this.views.entries()].slice(-MAX_SESSIONS)
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries))
    } catch {
      // Storage full or unavailable: the names simply do not persist.
    }
  }
}

export const deviceViewState = new DeviceViewState()

/** Open the Devices pane on its Builds view: the app builds agents handed over. */
export function openDeviceBuilds(shell: { openDevices(sessionId?: string, serverId?: string): void }, serverId: string, sessionId?: string): void {
  deviceViewState.showBuilds(serverId, true)
  shell.openDevices(sessionId, serverId)
}
