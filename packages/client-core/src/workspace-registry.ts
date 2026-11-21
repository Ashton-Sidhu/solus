/**
 * The organizations' workspace services this client knows, as the account
 * directory last listed them (docs/plans/workspace-and-machines.md §3). A
 * workspace service is a cloud service, never a host: the host catalog holds them
 * apart from the machines (`host-catalog.ts`), in memory only (plans/033). It has
 * no pairing and no LAN route, and it is dialed with a grant for its
 * `workspace:<organizationId>` id.
 */

import { solusApiId, type DirectoryWorkspace } from '@solus/contracts/uplink'
import { windowOrganizationSelection } from './organization-selection'
import type { SolusServerTarget } from './server-connection'

export interface KnownWorkspace extends DirectoryWorkspace {
  /** The account origin whose directory listed it, e.g. `https://app.solus.sh`. */
  directoryUrl: string
}

/**
 * Organization ids that two directories list. A connection is keyed by
 * `workspace:<organizationId>`, so such an id names no single service: the
 * registry dials neither rather than reach one service's records with the
 * other's identity (plans/015-notifications-hub.md §4).
 */
export function ambiguousOrganizationIds(workspaces: readonly KnownWorkspace[]): Set<string> {
  const directoryOf = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const workspace of workspaces) {
    const seen = directoryOf.get(workspace.organizationId)
    if (seen !== undefined && seen !== workspace.directoryUrl) ambiguous.add(workspace.organizationId)
    directoryOf.set(workspace.organizationId, workspace.directoryUrl)
  }
  return ambiguous
}

/** The workspace a `workspace:<organizationId>` id names; null when none, or when two directories list it. */
export function workspaceFor(workspaces: readonly KnownWorkspace[], serviceId: string): KnownWorkspace | null {
  const matches = workspaces.filter((workspace) => solusApiId(workspace.organizationId) === serviceId)
  if (matches.length === 0 || ambiguousOrganizationIds(matches).size > 0) return null
  return matches[0]!
}

/**
 * The workspace of the organization this window works in
 * (`organization-selection.ts`): the window's choice, else the one the account
 * is working in, else the first.
 */
export function activeWorkspace(
  workspaces: readonly KnownWorkspace[],
): KnownWorkspace | null {
  const organizationId = windowOrganizationSelection.reconcile(workspaces)
  return workspaces.find((workspace) => workspace.organizationId === organizationId) ?? null
}

/** How to dial a workspace service: its one tunnel, with a grant minted for its id. */
export function workspaceTarget(workspace: KnownWorkspace): SolusServerTarget {
  const id = solusApiId(workspace.organizationId)
  const routes = workspace.routes.filter((route) => route.kind === 'tunnel')
  return {
    id,
    label: workspace.label,
    url: routes[0]?.url ?? '',
    sessionToken: '',
    local: false,
    routes,
    uplink: { hostId: id, directoryUrl: workspace.directoryUrl, organizationIds: [workspace.organizationId] },
  }
}
