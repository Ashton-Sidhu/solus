import type { SolusApiScope, WorkspaceRecordHome } from '@solus/contracts/solus-api'
import type { Principal } from './principal'
import type { Attribution } from '@solus/contracts/user'
import { actorFor, attributionOf, ownerKeyOf } from './actor'

/** The host acting for the person, when the request came with its delegated token (plans/010-standard-oauth.md). */
export interface WorkspaceDelegation { hostId: string }

/** The authority of one Solus API request: who, where their records live, and what they may do. */
export interface WorkspaceRequestContext {
  principal: Principal
  home: WorkspaceRecordHome
  scopes: SolusApiScope[]
  delegation?: WorkspaceDelegation
  /** In-process agent provenance, supplied by the admitted turn or a host's delegated token. Never accepted in HTTP input. */
  actingAgent?: { sessionId?: string; organizationId: string; linkWorkToTask?: boolean }
}

/**
 * How a `/v1` request is admitted (`transport/solus-api/admission.ts`): over a socket,
 * by the socket's principal; over HTTP, by its bearer, in the organization it names.
 * Null: refused.
 */
export interface WorkspaceAdmission {
  socket(principal: Principal): Promise<WorkspaceRequestContext | null>
  bearer(bearer: string, organizationId: string | undefined): Promise<WorkspaceRequestContext | null>
}

/** Who a request is, as the doer of what it writes: its admitted agent turn and the person that turn is for, else its person. */
export function requestAttribution(context: WorkspaceRequestContext): Attribution {
  const actor = actorFor(context.principal)
  return context.actingAgent ? attributionOf(actor, { sessionId: context.actingAgent.sessionId ?? '' }) : attributionOf(actor)
}

/** Stable across credential renewal, distinct for two contexts/windows or guest links. */
export function workspaceAuthorityKey(context: WorkspaceRequestContext): string {
  const principal = context.principal
  return JSON.stringify([
    context.home,
    principal.kind,
    ownerKeyOf(actorFor(principal)),
    principal.kind === 'system' ? null : principal.deviceId,
    principal.kind === 'guest' ? principal.share.linkSecretHash : null,
    [...context.scopes].sort(),
    context.delegation?.hostId ?? null,
  ])
}
