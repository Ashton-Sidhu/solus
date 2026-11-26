/**
 * The hosts of Settings → Sharing & access, the page that T3 Code's Settings
 * calls Sharing & access: the person chooses one host, and the page shows how
 * outside apps and devices reach it.
 */

/** One host the page can show. */
export interface SharingAccessHost {
  readonly id: string;
  readonly label: string;
}

/** The connected hosts, in the order of the host list. A host that is not connected cannot answer. */
export function sharingAccessHosts(
  environments: readonly {
    readonly environmentId: string;
    readonly environmentLabel: string;
    readonly connectionState: string;
  }[],
): SharingAccessHost[] {
  return environments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => ({ id: environment.environmentId, label: environment.environmentLabel }));
}

/**
 * The host the page shows: the one the person chose on the page, else the one
 * the link names (a host page links to its own host), else the one Settings is
 * scoped to, else the first. A host that is no longer connected is skipped, so
 * the page never stays on a host that cannot answer. Null when no host is connected.
 */
export function sharingAccessHost(
  hosts: readonly SharingAccessHost[],
  preferred: {
    readonly chosen: string | null;
    readonly linked: string | null;
    readonly scoped: string | null;
  },
): string | null {
  for (const id of [preferred.chosen, preferred.linked, preferred.scoped]) {
    if (id !== null && hosts.some((host) => host.id === id)) return id;
  }
  return hosts[0]?.id ?? null;
}
