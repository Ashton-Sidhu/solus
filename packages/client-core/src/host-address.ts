/**
 * The addresses a host list prints beside a name that more than one host
 * carries. A row otherwise shows only the name, so two machines that report
 * the same hostname, or that the user named alike, read as one. A host whose
 * name is its own gets no address: there it is only noise.
 *
 * The address is the URL the host is reached at, without its scheme or a
 * trailing slash. Two hosts never share it, so it always tells them apart.
 */
export function sameNameHostAddresses(hosts: readonly { id: string; label: string; url: string }[]): Map<string, string> {
  const hostsByLabel = new Map<string, number>()
  for (const host of hosts) hostsByLabel.set(host.label, (hostsByLabel.get(host.label) ?? 0) + 1)
  const addresses = new Map<string, string>()
  for (const host of hosts) {
    if ((hostsByLabel.get(host.label) ?? 0) < 2 || !host.url) continue
    addresses.set(host.id, host.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, ''))
  }
  return addresses
}
