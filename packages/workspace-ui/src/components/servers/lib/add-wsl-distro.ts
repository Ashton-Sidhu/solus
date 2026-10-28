import type { SshAddResult, WslDistro } from '@solus/contracts/remote-machines'

/**
 * Adding a WSL distro of a Windows host as a machine (docs/plans/windows.md
 * §13.6). Pure decisions only: the store does the calls.
 */

/** The distro to preselect: the one `wsl` runs by default, else the first. */
export function defaultDistro(distros: readonly WslDistro[]): string {
  return (distros.find((distro) => distro.isDefault) ?? distros[0])?.name ?? ''
}

export type WslAddOutcome =
  /** Save the host with its forwarded route: this client dials it through its own host. */
  | { kind: 'save-forwarded'; message: string }
  /** The forward is on another machine, which lists the host; this client cannot dial it. */
  | { kind: 'forwarded-elsewhere'; message: string }
  | { kind: 'failed'; message: string }

/** What one answer of `hostsAddWsl` means here. Only the Windows host reaches its distro. */
export function wslAddOutcome(result: SshAddResult, isThisMachine: boolean, windowsHostName: string): WslAddOutcome {
  if (result.status !== 'forwarded') return { kind: 'failed', message: 'The host did not add the distro.' }
  return isThisMachine
    ? { kind: 'save-forwarded', message: `${result.host.label} is added. Pick it in Run on for work in its Linux files.` }
    : { kind: 'forwarded-elsewhere', message: `${result.host.label} is added. It is reachable only from ${windowsHostName}, which lists it.` }
}
