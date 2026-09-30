import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  solusApiScopeSchema, workspaceRecordHomeSchema, WORKSPACE_TOKEN_TTL_MS,
  type WorkspaceAuthSession, type WorkspaceAuthSessionRequest, type WorkspaceRecordHome,
} from '@solus/contracts/solus-api'
import { principalSchema, principalExpiresAt, type Principal } from './principal'
import type { Attribution } from '@solus/contracts/user'
import { actorFor, attributionOf, ownerKeyOf } from './actor'
import { readSignedToken, signToken } from './signed-token'

/** The host acting for the person, when the source was its delegated token (plans/010-standard-oauth.md). */
const delegationSchema = z.strictObject({ hostId: z.string().min(1) })
export type WorkspaceDelegation = z.infer<typeof delegationSchema>

const apiClaimsSchema = z.strictObject({
  purpose: z.literal('solus-api'),
  audience: z.string(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  principal: principalSchema,
  home: workspaceRecordHomeSchema,
  scopes: z.array(solusApiScopeSchema).min(1).max(7),
  delegation: delegationSchema.optional(),
})
export type WorkspaceRequestContext = Pick<z.infer<typeof apiClaimsSchema>, 'principal' | 'home' | 'scopes' | 'delegation'> & {
  /** In-process agent provenance, supplied by the admitted turn. Never accepted in HTTP input or credentials. */
  actingAgent?: { sessionId?: string; organizationId: string; linkWorkToTask?: boolean }
}

export interface WorkspaceCredentialOptions {
  audience: string
  /** Process-bound credentials stop working after restart; source authority can exchange again. */
  secret?: Buffer
  now?: () => number
  /** A host's delegated token also names the host acting for the person; its credential then speaks for that host's agent work. */
  authenticateSource(bearer: string, shareSecret?: string): Promise<{ principal: Principal; expiresAt: number; delegation?: WorkspaceDelegation } | null>
  isRevoked(principal: Principal): Promise<boolean>
  homeFor(principal: Principal): WorkspaceRecordHome | null
}

/** One credential verifier for HTTP, independent of sockets and domain stores. */
export class WorkspaceCredentials {
  private readonly secret: Buffer
  private readonly now: () => number
  constructor(private readonly options: WorkspaceCredentialOptions) {
    this.secret = options.secret ?? randomBytes(32)
    this.now = options.now ?? Date.now
  }

  async exchange(bearer: string, request: WorkspaceAuthSessionRequest): Promise<WorkspaceAuthSession | null> {
    if (!bearer || bearer.length > 16_384) return null
    const source = await this.options.authenticateSource(bearer, request.shareSecret)
    if (!source || source.principal.kind === 'system' || source.principal.kind === 'runner') return null
    if (await this.options.isRevoked(source.principal)) return null
    const home = this.options.homeFor(source.principal)
    if (!home) return null
    const issuedAt = this.now()
    const expiresAt = Math.min(issuedAt + WORKSPACE_TOKEN_TTL_MS, source.expiresAt, principalExpiresAt(source.principal) ?? Infinity)
    if (expiresAt <= issuedAt) return null
    const scopes = [...request.scopes]
    const actor = actorFor(source.principal)
    const claims: z.infer<typeof apiClaimsSchema> = { purpose: 'solus-api', audience: this.options.audience, issuedAt, expiresAt, principal: source.principal, home, scopes }
    if (source.delegation) claims.delegation = source.delegation
    return {
      accessToken: signToken(apiClaimsSchema.parse(claims), this.secret), tokenType: 'Bearer',
      expiresAt: new Date(expiresAt).toISOString(), scopes, home,
      subject: { kind: 'user', userId: ownerKeyOf(actor), displayName: actor.user?.displayName ?? 'Solus', sessionId: null },
    }
  }

  async verify(bearer: string): Promise<WorkspaceRequestContext | null> {
    if (!bearer || bearer.length > 16_384) return null
    const claims = readSignedToken(bearer, this.secret, apiClaimsSchema)
    const now = this.now()
    if (!claims || claims.audience !== this.options.audience || claims.expiresAt <= now || claims.issuedAt > now
      || claims.expiresAt - claims.issuedAt > WORKSPACE_TOKEN_TTL_MS) return null
    if (claims.principal.kind === 'system' || claims.principal.kind === 'runner') return null
    if (await this.options.isRevoked(claims.principal)) return null
    if (!claims.delegation) return { principal: claims.principal, home: claims.home, scopes: claims.scopes }
    // A host's agent acting for the person: its writes are the agent's, in the delegation's organization.
    const organizationId = claims.home.kind === 'organization' ? claims.home.organizationId : null
    if (!organizationId) return null
    return { principal: claims.principal, home: claims.home, scopes: claims.scopes, delegation: claims.delegation, actingAgent: { organizationId } }
  }
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
