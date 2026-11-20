import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { pairServer } from '@solus/client-core/pairing'
import type { KnownHost } from '@solus/client-core/known-host'
import { serversStore } from '../../contexts'
import { addOverSshStore } from '../servers/add-over-ssh.store.svelte'

/**
 * The commands of the Add page and Discover (docs/plans/host-fleet.md D8). Pairing
 * finishes where it starts; only SSH keeps its own form, which opens prefilled.
 */

/** Pairs with a host that runs Solus, with the code it shows, and saves it. Throws the host's refusal. */
export async function pairWithCode(url: string, code: string | undefined, reportedName?: string, onTailnet = false): Promise<KnownHost> {
  const result = await pairServer({ url, pairToken: code, deviceLabel: defaultDeviceLabel(), serverLabel: '', reportedName, onTailnet })
  await serversStore.savePairedServer(result.server)
  return result.server
}

/** Opens the SSH form, with the target filled in when one is known (an SSH config machine). */
export function openSshAdd(sshTarget = ''): void {
  addOverSshStore.ensureDraft()
  if (sshTarget) addOverSshStore.sshTarget = sshTarget
  serversStore.openAddServer('', 'ssh')
}
