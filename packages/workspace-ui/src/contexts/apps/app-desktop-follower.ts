import type { AppSummary, AppsChangedEvent } from '@solus/contracts/apps'
import { isSameAppShortcutTarget, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import type { AppShortcutsStore } from './app-shortcuts.store.svelte'

/** What the follower reads and hears. Each part is a port, so the rules run in a test with no host. */
export interface AppDesktopFollowerDeps {
  shortcuts: Pick<AppShortcutsStore, 'isAvailable' | 'loaded' | 'list' | 'follow' | 'forgetApp'>
  /** The apps that have a permission answer on this computer. */
  answeredApps(): Promise<readonly AppShortcutTarget[]>
  /** How this computer's records name the host of a connection: its installation id, else the connection id (`appPinOf`). */
  hostKeyOf(serverId: string): string
  /** The machines that are connected now. */
  readyHosts(): readonly string[]
  appList(serverId: string): Promise<readonly AppSummary[]>
  onAppsChanged(listener: (serverId: string, event: AppsChangedEvent) => void): () => void
  onHostReady(listener: (serverId: string) => void): () => void
}

/**
 * Keeps this computer's records of each app in step with the app's host
 * (docs/app-shortcuts.md §3 and §4), on the desktop only:
 *
 * - A delete of the app from any client (another desktop, web, mobile, an
 *   agent) clears its shortcut and launcher, its permission answers, and the
 *   place of its window here.
 * - A change of the app (a deploy, a rename, a new icon) writes its launcher
 *   again when the name or the icon key changed, without waiting for an open.
 * - When a host connects, an app that is gone from its list is cleared, and a
 *   launcher that is out of date is written again: the desktop app may have
 *   been closed when the change came.
 *
 * It reads a host's list only when this computer has a record of one of that
 * host's apps.
 */
export class AppDesktopFollower {
  constructor(private readonly deps: AppDesktopFollowerDeps) {}

  start(): () => void {
    if (!this.deps.shortcuts.isAvailable) return () => {}
    const stopChanges = this.deps.onAppsChanged((serverId, event) => void this.changed(serverId, event).catch(() => {}))
    const stopReady = this.deps.onHostReady((serverId) => void this.reconcile(serverId).catch(() => {}))
    for (const serverId of this.deps.readyHosts()) void this.reconcile(serverId).catch(() => {})
    return () => {
      stopChanges()
      stopReady()
    }
  }

  private async changed(serverId: string, event: AppsChangedEvent): Promise<void> {
    const host = this.deps.hostKeyOf(serverId)
    if (event.kind === 'deleted') {
      await this.deps.shortcuts.forgetApp({ host, appId: event.appId })
      return
    }
    await this.deps.shortcuts.loaded()
    const target = { host, appId: event.app.id }
    if (this.deps.shortcuts.list.some((shortcut) => isSameAppShortcutTarget(shortcut, target))) await this.deps.shortcuts.follow(target, serverId, event.app)
  }

  /** One host is connected: its list says which of its apps this computer still knows. */
  async reconcile(serverId: string): Promise<void> {
    const host = this.deps.hostKeyOf(serverId)
    await this.deps.shortcuts.loaded()
    const shortcuts = this.deps.shortcuts.list.filter((shortcut) => shortcut.host === host)
    const answered = (await this.deps.answeredApps()).filter((target) => target.host === host)
    if (shortcuts.length === 0 && answered.length === 0) return
    // A list that fails to read clears nothing: only a host's answer says that an app is gone.
    const apps = new Map((await this.deps.appList(serverId)).map((app) => [app.id, app]))
    const known = new Set<string>()
    for (const target of [...shortcuts, ...answered]) {
      if (known.has(target.appId)) continue
      known.add(target.appId)
      const app = apps.get(target.appId)
      if (!app) await this.deps.shortcuts.forgetApp({ host, appId: target.appId })
      else if (shortcuts.some((shortcut) => shortcut.appId === target.appId)) await this.deps.shortcuts.follow({ host, appId: target.appId }, serverId, app)
    }
  }
}
