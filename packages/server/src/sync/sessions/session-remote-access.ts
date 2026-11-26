import {
  SESSION_REPOSITORY_HEAD_PATH, SESSION_REPOSITORY_TOKEN_PATH,
  sessionRepositoryHeadResponseSchema, sessionRepositoryTokenResponseSchema,
  type SessionCloudScope, type SessionRepositoryHeadRequest, type SessionRepositoryTokenRequest, type SessionRepositoryTokenResponse,
} from '@solus/contracts/session-repositories'
import type { HostRegistration } from '@solus/contracts/uplink'
import { DelegationError, type Delegations } from '../delegations'

export type SessionRemoteResult =
  | { status: 'ready'; remote: SessionRepositoryTokenResponse }
  | { status: 'unavailable' }

/** Who asks the Solus API about a session repository: the cloud scope that holds it, and the person whose delegation the host uses. */
export interface SessionCloudIdentity {
  cloudScope: SessionCloudScope
  actorUserId: string
}

export interface SessionRemoteAccess {
  remote(sessionId: string, identity: SessionCloudIdentity, access: 'read' | 'write'): Promise<SessionRemoteResult>
  report(request: SessionRepositoryHeadRequest, identity: SessionCloudIdentity): Promise<'accepted' | 'unavailable' | 'conflict'>
  /** A short-lived signed URL of one code bundle: `PUT` its bytes with a Content-Length to write, `GET` to read. */
  codeUrl(request: { sessionId: string; sha256: string; bytes: number; access: 'read' | 'write' }, identity: SessionCloudIdentity): Promise<{ status: 'ready'; url: string } | { status: 'unavailable' }>
}

/** The API names the repository. The host only selects the person's delegation. */
export class DelegatedSessionRemoteAccess implements SessionRemoteAccess {
  constructor(
    private readonly registration: () => HostRegistration | null,
    private readonly delegations: Delegations,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request({ cloudScope, actorUserId }: SessionCloudIdentity, path: string, body: SessionRepositoryTokenRequest | SessionRepositoryHeadRequest): Promise<Response> {
    const registration = this.registration()
    if (!registration?.apiUrl) throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'The Solus API is not available.')
    const separator = cloudScope.indexOf(':')
    const userId = cloudScope.slice(separator + 1)
    const scope = cloudScope.startsWith('person:') ? 'personal' as const : { organizationId: userId }
    const token = await this.delegations.accessToken(actorUserId, scope, { kind: 'api' })
    return this.fetchImpl(new URL(path, registration.apiUrl).toString(), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
  }

  async remote(sessionId: string, identity: SessionCloudIdentity, access: 'read' | 'write'): Promise<SessionRemoteResult> {
    const registration = this.registration()
    if (!registration) return { status: 'unavailable' }
    const response = await this.request(identity, SESSION_REPOSITORY_TOKEN_PATH, { hostId: registration.hostId, sessionId, access })
    if (response.status === 404 || response.status === 503) return { status: 'unavailable' }
    if (!response.ok) throw new Error(`Session repository token request failed (${response.status}).`)
    return { status: 'ready', remote: sessionRepositoryTokenResponseSchema.parse(await response.json()) }
  }

  async report(request: SessionRepositoryHeadRequest, identity: SessionCloudIdentity): Promise<'accepted' | 'unavailable' | 'conflict'> {
    const response = await this.request(identity, SESSION_REPOSITORY_HEAD_PATH, request)
    if (response.status === 404 || response.status === 503) return 'unavailable'
    if (response.status === 409) return 'conflict'
    if (!response.ok) throw new Error(`Session repository head request failed (${response.status}).`)
    sessionRepositoryHeadResponseSchema.parse(await response.json())
    return 'accepted'
  }

  // Part 2 replaces this.
  async codeUrl(_request: Parameters<SessionRemoteAccess['codeUrl']>[0], _identity: SessionCloudIdentity): Promise<{ status: 'ready'; url: string } | { status: 'unavailable' }> {
    return { status: 'unavailable' }
  }
}
