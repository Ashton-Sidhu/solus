import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import { isServerUpdateActive, type ServerUpdateOperation } from '@solus/contracts/server-update'
import { updateCheckFailureText } from '@solus/client-core/host-update-text'

/** What a host's last update check found, in one short line. */
export function updateStatusText(status: Pick<HostUpdateStatus, 'install' | 'check'> & Partial<Pick<HostUpdateStatus, 'providers'>>): string {
  if (status.install === 'cloud') return 'Updated by Solus Cloud'
  const failure = updateCheckFailureText(status)
  if (failure) return failure
  const { check } = status
  switch (check.kind) {
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return 'Up to date'
    case 'available': return `Version ${check.latestVersion} is available`
    case 'error': return `Solus: ${check.message}`
    case 'idle': return check.reason ?? 'Not checked yet'
  }
}

/** What a Solus update the host runs is doing now, in one short line. */
export function serverUpdateText(operation: ServerUpdateOperation): string {
  switch (operation.phase) {
    case 'waiting': return 'Waiting for running work to finish…'
    case 'downloading': return `Downloading version ${operation.version}…`
    case 'restarting': return 'Restarting and reconnecting…'
    case 'succeeded': return `Updated to ${operation.version}`
    case 'failed': return operation.message ? `Update failed: ${operation.message}` : 'Update failed'
    case 'cancelled': return 'Update cancelled'
  }
}

/** The one update control a host row offers (T3 #21402, as desktop's HostUpdateRow). */
export type HostUpdateAction =
  | { kind: 'none' }
  /** Install the release; `retry` after a failed update. */
  | { kind: 'update'; version: string; retry: boolean }
  /** The update waits for running work: it can still be cancelled. */
  | { kind: 'cancel' }
  /** The host downloads or restarts: nothing to press. */
  | { kind: 'updating' }
  /** A release the host cannot install itself; `text` says what to do. */
  | { kind: 'manual'; text: string }
  /** A release this person may not install: only a host administrator can. */
  | { kind: 'limited' }

/**
 * The update controls of one host. Checking, installing, and cancelling need
 * `host.admin` (`isAdmin`); the host refuses them otherwise, so they are not
 * offered. A host Solus cloud provisioned is updated by Solus cloud.
 */
export function hostUpdateControls(status: HostUpdateStatus | null, isAdmin: boolean): { canCheck: boolean; action: HostUpdateAction } {
  if (!status || status.install === 'cloud') return { canCheck: false, action: { kind: 'none' } }
  const operation = status.serverUpdate?.operation ?? null
  const active = isServerUpdateActive(operation)
  const canCheck = isAdmin && !active && status.check.kind !== 'checking'
  if (operation?.phase === 'waiting' && isAdmin) return { canCheck, action: { kind: 'cancel' } }
  if (active) return { canCheck, action: { kind: 'updating' } }
  if (status.check.kind !== 'available') return { canCheck, action: { kind: 'none' } }
  if (!isAdmin) return { canCheck, action: { kind: 'limited' } }
  if (!status.serverUpdate?.supported) {
    return { canCheck, action: { kind: 'manual', text: status.serverUpdate?.reason ?? status.remediation ?? 'Update Solus on this host.' } }
  }
  return { canCheck, action: { kind: 'update', version: status.check.latestVersion, retry: operation?.phase === 'failed' } }
}
