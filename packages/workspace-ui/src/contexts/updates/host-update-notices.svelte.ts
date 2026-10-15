import { serverUpdateText } from './server-update-text'
import { untrack } from 'svelte'
import { isSessionBusyStatus } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { updateCheckFailureText } from '@solus/client-core/host-update-text'
import { hostUpdatesStore, type HostUpdateItem } from './host-updates.store.svelte'
import { hostUpdater } from './host-updater.svelte'
import { updateNoticeText, updateProgressText, updateSummaryText, type UpdateOutcome } from './host-update-text'
import type { createAppCore } from '../app/app-core'
import type { ClientShellContext } from '../app/client-shell.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { toasts } from '../../lib/toasts'
import { notificationsStore } from '../notifications/notifications.store.svelte'
import { runHost } from '../workspace/run-location'

/** Every pending host update, and every update `hostUpdater` runs, share this one toast. */
const UPDATES_TOAST_ID = 'host-updates'

function hostLabel(serverId: string): string {
  return serversStore.servers.find((host) => host.id === serverId)?.label ?? 'this host'
}

function updatesKey(items: HostUpdateItem[]): string {
  return items.map((item) => `${item.serverId}:${item.target}@${item.version}`).sort().join('|')
}

export function installHostUpdateNotices(session: ReturnType<typeof createAppCore>['session'], _shell: ClientShellContext): void {
  hostUpdatesStore.start()
  // A manual check's answer is feedback for a click, so it is reported either way.
  $effect(() => {
    const hosts = new Set([...hostUpdatesStore.statuses.keys(), ...hostUpdatesStore.errors.keys()])
    for (const serverId of hosts) {
      const outcome = hostUpdatesStore.manualCheckOutcomeFor(serverId)
      if (!outcome) continue
      untrack(() => {
        hostUpdatesStore.markManualCheckReported(serverId)
        if (outcome === 'up-to-date') toasts.success(`Checked software on ${hostLabel(serverId)} is up to date`)
        else {
          const status = hostUpdatesStore.hostUpdateFor(serverId)
          toasts.error(`Update check failed on ${hostLabel(serverId)}`, { description: hostUpdatesStore.errors.get(serverId) ?? (status ? updateCheckFailureText(status) : null) ?? 'The host did not report a reason.' })
        }
      })
    }
  })

  // The notice lists what it would update; while a batch runs, the same toast shows the batch.
  let shownKey: string | null = null
  $effect(() => {
    if (hostUpdater.items.length) {
      const entries = hostUpdater.items.map((item) => {
        const outcome = hostUpdater.outcomeOf(item)
        const host = hostLabel(item.serverId)
        const shown: UpdateOutcome = outcome.phase !== 'running' ? outcome
          : { phase: 'running', detail: outcome.operation ? serverUpdateText(outcome.operation, host, hostUpdatesStore.statuses.has(item.serverId)) : null }
        return { target: item.target, version: item.version, host, outcome: shown }
      })
      const settled = hostUpdater.isSettled
      const canCancel = hostUpdater.items.some((item) => item.target === 'solus' && hostUpdatesStore.operations.get(item.serverId)?.phase === 'waiting' && hostUpdatesStore.statuses.has(item.serverId))
      untrack(() => {
        shownKey = null
        if (settled) {
          const summary = updateSummaryText(entries)
          toasts.show({ id: UPDATES_TOAST_ID, message: summary.message, description: summary.description, variant: summary.hasFailed ? 'error' : 'success', duration: 8_000, closeButton: true })
          hostUpdater.finish()
        } else {
          const progress = updateProgressText(entries)
          toasts.show({
            id: UPDATES_TOAST_ID, message: progress.message, description: progress.description, duration: Infinity, closeButton: true,
            actions: canCancel ? [{ label: 'Cancel Solus update', onAction: () => {
              void hostUpdater.cancelWaiting().then((failures) => {
                if (failures.length) toasts.error('Could not cancel the Solus update', { description: failures.join('\n') })
              })
            } }] : [],
          })
        }
      })
      return
    }
    // Read here, not under `untrack`, so a notice held back by the switch
    // shows once the switch is turned on.
    const updateNoticesWanted = notificationsStore.wants('update_available')
    // A host with work running is not interrupted; its updates join the notice once it is idle.
    const busyHosts = new Set(Object.values(session.sessions.byId).filter((item) => isSessionBusyStatus(item.status)).map((item) => serverConnections.resolveId(runHost(item.run))))
    const items = hostUpdatesStore.installableUpdates.filter((item) => !busyHosts.has(item.serverId))
    const key = updatesKey(items)
    untrack(() => {
      if (key === shownKey) return
      if (!items.length) {
        if (shownKey !== null) toasts.dismiss(UPDATES_TOAST_ID)
        shownKey = null
        return
      }
      // A notice on screen follows the list; a new one needs a release the user has not seen.
      if (shownKey === null && (!updateNoticesWanted || items.every((item) => hostUpdatesStore.isNoticeShown(item)))) return
      for (const item of items) hostUpdatesStore.markNoticeShown(item)
      const text = updateNoticeText(items.map((item) => ({ target: item.target, version: item.version, host: hostLabel(item.serverId) })))
      // Replacing the toast in place dismisses the previous one, so set the key after.
      toasts.show({
        id: UPDATES_TOAST_ID, message: text.message, description: text.description,
        duration: 15_000, closeButton: true,
        onDismiss: () => { shownKey = null },
        actions: [
          { label: items.length === 1 ? 'Update' : 'Update all', onAction: () => { shownKey = null; void hostUpdater.update(items) } },
          { label: 'Later', onAction: () => { shownKey = null } },
        ],
      })
      shownKey = key
    })
  })
}
