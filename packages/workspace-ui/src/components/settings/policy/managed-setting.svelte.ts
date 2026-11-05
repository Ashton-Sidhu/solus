import type { ManagedHostKey, ManagedSessionSettingKey } from '@solus/contracts/policy'
import { HostPolicies } from '@solus/contracts/host-policies'
import { serversStore } from '../../../contexts'
import { hosts } from '../../../contexts/hosts/hosts.svelte'
import { policiesOn } from '../../../contexts/policy/work-policy.svelte'
import { hostLockNote, pairingLockNote, solusToolsLock } from './lib/host-locks'
import { managedSettingNote, type ManagedSettingNote } from './lib/managed-setting-note'

/** Personal settings apply on every host; the page shows the locks of this device's host, else of the Run on host. */
export function settingsPolicies(): HostPolicies {
  return (hosts.device ?? hosts.runOn)?.policies ?? HostPolicies.none
}

/** The note under one managed personal setting. Reactive: read it in markup or in `$derived`. */
export function managedSetting(key: ManagedSessionSettingKey): ManagedSettingNote {
  return managedSettingNote(settingsPolicies(), serversStore.organizations, key)
}

/** The lock note of one machine-wide key on the host a page shows. Reactive. */
export function hostLock(serverId: string, key: ManagedHostKey): ManagedSettingNote | undefined {
  return hostLockNote(policiesOn(serverId), key)
}

/** The pairing lock on the host a page shows, from `remoteAccess: false`. Reactive. */
export function pairingLock(serverId: string): ManagedSettingNote | undefined {
  return pairingLockNote(policiesOn(serverId))
}

/** The Solus tools a policy locks on the host a page shows. Reactive. */
export function solusToolsPolicyLock(serverId: string): ReturnType<typeof solusToolsLock> {
  return solusToolsLock(policiesOn(serverId))
}

/** "<Name> manages Solus updates." when a policy turns updates off on a host; else undefined. Reactive. */
export function updatesLock(serverId: string): ManagedSettingNote | undefined {
  const message = policiesOn(serverId).updatesManagedMessage()
  return message ? { lockedEverywhere: true, lines: [message] } : undefined
}

/** The updates lock of this device's host: the desktop app's own updates follow it. Reactive. */
export function deviceUpdatesLock(): ManagedSettingNote | undefined {
  const device = hosts.device
  return device ? updatesLock(device.id) : undefined
}
