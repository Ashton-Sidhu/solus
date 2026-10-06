import type { WorkspaceOperations } from './operations'
import { workspaceToolAuthority } from '../../admission/workspace-tool-authority'
import { ANY_ORGANIZATION, INTERNAL_PRINCIPAL, LOCAL_ORGANIZATION_ID, organizationForNew, recordScopeOf } from '../../admission/principal'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import { isOrganizationAttached } from '../../host/organization-attachment'
import { getSessionRecord } from '../sessions/session-records'

/**
 * Where an organization run's records are read and written: its Solus API, as the
 * person the run's authority names (organization-vms §3). Installed by the boot;
 * null when the run holds no valid authority, which the tool reports rather than
 * writing a Local record in its place.
 */
export type RemoteToolOperations = (sessionId: string) => WorkspaceOperations | null

interface Installed { operations: WorkspaceOperations; hostId: string; remote?: RemoteToolOperations }

let installed: Installed | undefined
export function installWorkspaceToolOperations(operations: WorkspaceOperations, hostId: string, remote?: RemoteToolOperations): () => void {
  const value: Installed = { operations, hostId, remote }; installed = value
  return () => { if (installed === value) installed = undefined }
}

export interface WorkspaceToolContext {
  operations: WorkspaceOperations
  context: WorkspaceRequestContext
  /** The session's records live on its organization's Solus API, not on this host. */
  remote: boolean
  /** Remote sessions only: the person whose delegated token delivers what is queued for the API (plans/010-standard-oauth.md). */
  deliveryActor?: string
}

/**
 * The record operations an agent tool uses, decided by its session's saved home
 * (organization-vms §3): a session on an attached machine whose home is the Solus
 * API reads and writes there; every other session reads and writes this host's
 * store with its admitted authority. The host's own work retains host authority;
 * member turns retain their admitted principal.
 */
export async function workspaceToolContext(sessionId?: string): Promise<WorkspaceToolContext> {
  if (!installed) throw new Error('Workspace operations are not initialized.')
  const principal = workspaceToolAuthority() ?? INTERNAL_PRINCIPAL
  const home = sessionId ? await getSessionRecord(ANY_ORGANIZATION, sessionId) : null
  if (sessionId && home && isOrganizationAttached() && home.organizationId !== LOCAL_ORGANIZATION_ID && home.publication === 'published') {
    const operations = installed.remote?.(sessionId)
    if (!operations) throw new SolusApiError(503, 'CAPABILITY_UNAVAILABLE', 'This organization session holds no authority for its Solus API right now. Send the next message from Solus to continue; nothing was saved on this machine.')
    return { operations, remote: true, deliveryActor: home.ownerUserId ?? '', context: {
      principal, home: { kind: 'organization', serviceId: 'remote', organizationId: home.organizationId },
      scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read'],
      actingAgent: { sessionId, organizationId: home.organizationId },
    } }
  }
  const session = sessionId ? await getSessionRecord(recordScopeOf(principal), sessionId) : null
  return { operations: installed.operations, remote: false, context: {
    principal, home: { kind: 'local', hostId: installed.hostId },
    scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read'],
    actingAgent: { sessionId, organizationId: session?.organizationId ?? organizationForNew(principal) },
  } }
}
