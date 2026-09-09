import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { isSessionBusyStatus } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostUpdatesStore, type HostUpdateNotice } from './host-updates.store.svelte'
import type { createAppCore } from '../app/app-core'
import type { ClientShellContext } from '../app/client-shell.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { hostSetupStore } from '../../components/servers/host-setup.store.svelte'
import { toasts } from '../../lib/toasts'

export function installHostUpdateNotices(session: ReturnType<typeof createAppCore>['session'], shell: ClientShellContext): void {
  hostUpdatesStore.start()
  const shown = new SvelteMap<string, HostUpdateNotice>()
  $effect(() => {
    const hosts = new Set([...hostUpdatesStore.statuses.keys(), ...hostUpdatesStore.errors.keys()])
    const busyHosts = new Set(Object.values(session.sessions).filter((item) => isSessionBusyStatus(item.status)).map((item) => serverConnections.resolveId(item.run.serverId)))
    for (const [serverId, notice] of shown) {
      const status = hostUpdatesStore.hostUpdateFor(serverId)
      const check = notice.target === 'solus' ? status?.check : status?.providers.find((p) => p.agent === notice.target)?.check
      if (shell.isOverlayWindow || busyHosts.has(serverId) || check?.kind !== 'available' || check.latestVersion !== notice.version) {
        untrack(() => { toasts.dismiss(`host-update:${serverId}`); shown.delete(serverId) })
      }
    }
    if (shell.isOverlayWindow) return
    for (const serverId of hosts) {
      if (busyHosts.has(serverId)) continue
      const notice = hostUpdatesStore.pendingNoticeFor(serverId)
      const hasShownNotice = shown.has(serverId)
      const outcome = hostUpdatesStore.manualCheckOutcomeFor(serverId)
      const label = serversStore.servers.find((host) => host.id === serverId)?.label ?? 'this host'
      untrack(() => {
        if (outcome) {
          hostUpdatesStore.markManualCheckReported(serverId)
          if (outcome === 'up-to-date') toasts.success(`Checked software on ${label} is up to date`)
          else toasts.error(`Update check failed on ${label}`, { description: hostUpdatesStore.errors.get(serverId) ?? 'Open the host to see which check failed.' })
        }
        if (!notice || hasShownNotice) return
        const target = notice.target === 'solus' ? 'Solus' : notice.target === 'claude' ? 'Claude Code' : 'Codex'
        hostUpdatesStore.markNoticeShown(serverId, notice)
        shown.set(serverId, notice)
        toasts.show({
          id: `host-update:${serverId}`, message: `${target} ${notice.version} is available on ${label}`,
          duration: 15_000, closeButton: true,
          onDismiss: () => { shown.delete(serverId) },
          actions: notice.target === 'solus' ? [] : [
            { label: 'Update', onAction: () => {
              shown.delete(serverId)
              if (notice.target !== 'solus') void hostSetupStore.sessionFor(serverId).updateProvider(notice.target)
            } },
            { label: 'Later', onAction: () => { shown.delete(serverId) } },
          ],
        })
      })
    }
  })
}
