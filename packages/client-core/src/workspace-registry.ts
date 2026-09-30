/**
 * The organizations' workspace services this client knows, as the account
 * directory last listed them (docs/plans/workspace-and-machines.md §3). A
 * workspace service is a cloud service, never a host: it is kept apart from the
 * saved machines (`server-registry.ts`), it has no pairing and no LAN route, and
 * it is dialed with a grant for its `workspace:<organizationId>` id.
 */

import { directoryWorkspaceSchema, solusApiId, type DirectoryWorkspace } from '@solus/contracts/uplink'
import { z } from 'zod'
import { forwardCompatibleArray } from './forward-compat'
import { windowOrganizationSelection } from './organization-selection'
import type { SolusServerTarget } from './server-connection'

const KEY = 'solus.workspaces'

export interface SavedWorkspace extends DirectoryWorkspace {
  /** The account origin whose directory listed it, e.g. `https://app.solus.sh`. */
  directoryUrl: string
}

const savedWorkspaceSchema = directoryWorkspaceSchema.extend({ directoryUrl: z.string().min(1) })
const savedWorkspacesSchema = forwardCompatibleArray(savedWorkspaceSchema)

export function loadWorkspaces(): SavedWorkspace[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const decoded = savedWorkspacesSchema.safeParse(JSON.parse(raw))
    if (decoded.success) return decoded.data
  } catch {}
  try {
    localStorage.removeItem(KEY)
  } catch {}
  return []
}

/**
 * Replaces what one directory said about the workspace services. A workspace
 * lives only as long as the directory lists it; another origin's are kept.
 */
export function saveDirectoryWorkspaces(workspaces: readonly DirectoryWorkspace[], directoryUrl: string): SavedWorkspace[] {
  const kept = loadWorkspaces().filter((workspace) => workspace.directoryUrl !== directoryUrl)
  const next = [...kept, ...workspaces.map((workspace) => ({ ...workspace, directoryUrl }))]
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}

/** The saved workspace a `workspace:<organizationId>` id names, or null. */
export function savedWorkspaceFor(serviceId: string): SavedWorkspace | null {
  return loadWorkspaces().find((workspace) => solusApiId(workspace.organizationId) === serviceId) ?? null
}

/**
 * The workspace of the organization this window works in
 * (`organization-selection.ts`): the window's choice, else the one the account
 * is working in, else the first.
 */
export function activeWorkspace(
  workspaces: readonly SavedWorkspace[],
): SavedWorkspace | null {
  const organizationId = windowOrganizationSelection.reconcile(workspaces)
  return workspaces.find((workspace) => workspace.organizationId === organizationId) ?? null
}

/** The organization this window works in, read from the saved workspaces; null with none. */
export function activeOrganizationId(): string | null {
  return windowOrganizationSelection.reconcile(loadWorkspaces())
}

/** How to dial a workspace service: its one tunnel, with a grant minted for its id. */
export function workspaceTarget(workspace: SavedWorkspace): SolusServerTarget {
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
