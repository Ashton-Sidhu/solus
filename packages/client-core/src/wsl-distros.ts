import { WSL_TARGET_PREFIX, type ForwardedHost, type WslDistro } from '@solus/contracts/remote-machines'

/**
 * The distros of a Windows host that it does not reach yet, which every client
 * offers to add beside its nearby hosts (docs/plans/windows.md §5.13). A distro
 * the host forwards to is a host already, listed with the others.
 */
export function unaddedDistros(distros: readonly WslDistro[], forwarded: readonly Pick<ForwardedHost, 'sshTarget'>[]): WslDistro[] {
  const added = new Set(forwarded.map((host) => host.sshTarget))
  return distros.filter((distro) => !added.has(`${WSL_TARGET_PREFIX}${distro.name}`))
}
