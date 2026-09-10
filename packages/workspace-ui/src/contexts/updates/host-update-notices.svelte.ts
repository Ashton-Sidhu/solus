import { isServerUpdateActive } from '@solus/contracts/server-update'
import { serverUpdateText } from './server-update-text'
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
  const observedOperations = new Map<string, string>()
  const operationPhases = new Map<string, string>()
  $effect(() => {
    for (const serverId of observedOperations.keys()) {
      if (shell.isOverlayWindow || hostUpdatesStore.operations.get(serverId)?.operationId !== observedOperations.get(serverId)) {
        untrack(() => { toasts.dismiss(`server-install:${serverId}`); operationPhases.delete(serverId) })
      }
    }
    if (shell.isOverlayWindow) return
    for (const [serverId, message] of hostUpdatesStore.updateErrors) {
      const label = serversStore.servers.find((host) => host.id === serverId)?.label ?? 'this host'
      untrack(() => {
        toasts.error(`Could not update Solus on ${label}`, { description: message })
        hostUpdatesStore.updateErrors.delete(serverId)
      })
    }
    for (const [serverId, operation] of hostUpdatesStore.operations) {
      const connected = hostUpdatesStore.statuses.has(serverId)
      const phaseKey = `${operation.operationId}:${operation.phase}:${connected}`
      if (operationPhases.get(serverId) === phaseKey) continue
      const active = isServerUpdateActive(operation)
      if (!active && observedOperations.get(serverId) !== operation.operationId) continue
      const label = serversStore.servers.find((host) => host.id === serverId)?.label ?? 'this host'
      untrack(() => {
        observedOperations.set(serverId, operation.operationId)
        operationPhases.set(serverId, phaseKey)
        toasts.show({
          id: `server-install:${serverId}`, message: serverUpdateText(operation, label, connected),
          description: operation.message, duration: active ? Infinity : 8_000,
          variant: operation.phase === 'failed' ? 'error' : operation.phase === 'succeeded' ? 'success' : 'info',
          closeButton: true,
          actions: operation.phase === 'waiting' && connected ? [{ label: 'Cancel', onAction: () => { void hostUpdatesStore.cancelUpdate(serverId) } }] : [],
        })
      })
    }
  })
  const shown = new SvelteMap<string, HostUpdateNotice>()
  $effect(() => {
    const hosts = new Set([...hostUpdatesStore.statuses.keys(), ...hostUpdatesStore.errors.keys()])
    const busyHosts = new Set(Object.values(session.sessions).filter((item) => isSessionBusyStatus(item.status)).map((item) => serverConnections.resolveId(item.run.serverId)))
    for (const [serverId, notice] of shown) {
      const status = hostUpdatesStore.hostUpdateFor(serverId)
      const check = notice.target === 'solus' ? status?.check : status?.providers.find((p) => p.agent === notice.target)?.check
      if (shell.isOverlayWindow || busyHosts.has(serverId) || isServerUpdateActive(hostUpdatesStore.operations.get(serverId)) || check?.kind !== 'available' || check.latestVersion !== notice.version) {
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
          actions: notice.target === 'solus' && !hostUpdatesStore.hostUpdateFor(serverId)?.serverUpdate?.supported ? [] : [
            { label: 'Update', onAction: () => {
              shown.delete(serverId)
              if (notice.target === 'solus') void hostUpdatesStore.install(serverId)
              else void hostSetupStore.sessionFor(serverId).updateProvider(notice.target)
            } },
            { label: 'Later', onAction: () => { shown.delete(serverId) } },
          ],
        })
      })
    }
  })
}
