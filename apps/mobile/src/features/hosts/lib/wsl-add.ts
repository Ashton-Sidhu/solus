import type { ForwardedHost, SshAddProgress, SshAddResult, WslDistro, WslDistroList } from '@solus/contracts/remote-machines'
import type { HostApi } from '@solus/client-core/host-api'
import type { SshAddConnection } from './ssh-add'
import { forwardedReachNote } from './ssh-add'

/**
 * Adding a WSL distro of a Windows host from the phone (docs/plans/windows.md
 * §13.6). The Windows host installs Solus in the distro and holds a forward to
 * it, so only that host reaches it until it is linked to the account.
 */

/** The narrow part of a host connection the add uses. */
export interface WslAddConnection {
  readonly api: Pick<HostApi, 'hostsListWslDistros' | 'hostsAddWsl'>
  readonly events: SshAddConnection['events']
}

/** The distro to preselect: the one `wsl` runs by default, else the first. */
export function defaultDistro(distros: readonly WslDistro[]): string | null {
  return (distros.find((distro) => distro.isDefault) ?? distros[0])?.name ?? null
}

/** The note under a distro row: its WSL version, and whether `wsl` runs it by default. */
export function distroNote(distro: WslDistro): string {
  return `${distro.isDefault ? 'Default · ' : ''}WSL ${distro.version}`
}

/** The distros of the host, or the reason to show instead. */
export async function readDistros(connection: WslAddConnection): Promise<WslDistroList> {
  return connection.api.hostsListWslDistros()
}

/** Runs one add on the Windows host. Progress for this request goes to `onProgress`; the subscription ends with the call. */
export async function runWslAdd(
  connection: WslAddConnection,
  distro: string,
  options: { readonly requestId: string; readonly deviceLabel: string; readonly onProgress: (progress: SshAddProgress) => void },
): Promise<SshAddResult> {
  const stop = connection.events.subscribe('host.sshProgress', (progress) => {
    if (progress.requestId === options.requestId) options.onProgress(progress)
  })
  try {
    return await connection.api.hostsAddWsl({ distro, requestId: options.requestId, deviceLabel: options.deviceLabel })
  } finally {
    stop()
  }
}

/** What the screen shows after the Windows host answered. */
export type WslAddOutcome =
  | { kind: 'forwarded'; host: ForwardedHost; note: string }
  | { kind: 'failed'; message: string }

export function wslAddOutcome(result: SshAddResult, hostLabel: string): WslAddOutcome {
  return result.status === 'forwarded'
    ? { kind: 'forwarded', host: result.host, note: forwardedReachNote(result.host.label, hostLabel) }
    : { kind: 'failed', message: 'The host did not add the distro.' }
}
