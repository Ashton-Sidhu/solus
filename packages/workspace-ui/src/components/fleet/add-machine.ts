import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { serverConnections } from '@solus/client-core/server-connections'
import { pairServer, requestPairApproval } from '@solus/client-core/pairing'
import type { KnownHost } from '@solus/client-core/known-host'
import { serversStore } from '../../contexts'
import { addOverSshStore } from '../servers/add-over-ssh.store.svelte'

/**
 * The commands of the Add page and Discover. Pairing
 * finishes where it starts; only SSH keeps its own form, which opens prefilled.
 */

/** Pairs with a host that runs Solus, with the code it shows, and saves it. Throws the host's refusal. */
export async function pairWithCode(url: string, code: string | undefined, reportedName?: string, onTailnet = false): Promise<KnownHost> {
  const result = await pairServer({ url, pairToken: code, deviceLabel: defaultDeviceLabel(), serverLabel: '', reportedName, onTailnet })
  await serversStore.savePairedServer(result.server)
  return result.server
}

/** A machine to pair this device with: where it answers, and what it said it is. */
export interface PairTarget {
  url: string
  /** From its `/health`; a host this device reaches can pair it only by this id. */
  installationId?: string
  name?: string
  /** The name the person typed; the host's own name when absent. */
  label?: string
  onTailnet?: boolean
}

/**
 * Pairs this device with a machine in the ways that need no code and nobody at
 * that machine, best first (docs/host-map.md): through a host this device
 * reaches that already paired it, then as a device that its network trusts.
 * The caller saves the host it returns (`savePairedServer`). Null when neither
 * works: SSH or a code is next.
 */
export async function pairWithoutCode(target: PairTarget): Promise<KnownHost | null> {
  if (target.installationId && await serverConnections.pairAgain(target.installationId).catch(() => false)) {
    const host = hostCatalog.find(target.installationId)
    if (host) return host
  }
  try {
    const result = await pairServer({ url: target.url, deviceLabel: defaultDeviceLabel(), serverLabel: target.label ?? '', reportedName: target.name, onTailnet: target.onTailnet })
    return result.server
  } catch {
    return null
  }
}

/** A host that has no approval requests (an older Solus): only a pairing code adds it. Asking again does not help. */
export class ApprovalUnavailableError extends Error {
  constructor() {
    super('That machine runs an older Solus, which does not take approval requests. Use a pairing code.')
    this.name = 'ApprovalUnavailableError'
  }
}

/**
 * Asks a host to pair this device without a code (docs/plans/add-machine-card.md):
 * the host's owner approves it after comparing `checkCode`, which the caller shows
 * at once. Saves the host when approved; throws when it was not, or on `signal`.
 * `onTailnet` saves the route as Tailscale, as `pairWithCode` does: the address
 * alone does not prove it.
 */
export async function pairWithApproval(url: string, checkCode: string, onWaiting: (start: { expiresAt: number }) => void, signal?: AbortSignal, onTailnet = false): Promise<KnownHost> {
  const outcome = await requestPairApproval({ url, checkCode, deviceLabel: defaultDeviceLabel(), serverLabel: '', onWaiting, signal, onTailnet })
  switch (outcome.status) {
    case 'approved':
      await serversStore.savePairedServer(outcome.result.server)
      return outcome.result.server
    case 'denied':
      throw new Error('The owner of that machine denied the request.')
    case 'expired':
      throw new Error('Nobody approved the request before it expired. Ask again.')
    case 'unavailable':
      throw new ApprovalUnavailableError()
  }
}

/** Opens the SSH form, with the target filled in when one is known (an SSH config machine). */
export function openSshAdd(sshTarget = ''): void {
  addOverSshStore.ensureDraft()
  if (sshTarget) addOverSshStore.sshTarget = sshTarget
  serversStore.openAddServer('', 'ssh')
}
