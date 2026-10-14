import {
  PROFILE_CREDENTIAL_PATH,
  profileCredentialConflictBodySchema,
  profileCredentialDeliverySchema,
  profileCredentialUploadResponseSchema,
  type ProfileCredential,
  type ProfileCredentialDelivery,
} from '@solus/contracts/integrations/profile-credentials'
import { createLogger } from '../logger'
import type { AccountReads } from '../vault/account-reads'

const log = createLogger('integrations', 'cloud-credentials.ts')

/** A cached token with less than this left is read again before use. */
const RENEWAL_MARGIN_MS = 60_000

/**
 * A person's MCP credentials in their account, as this host reads them
 * (plans/020-agent-profile.md §5.2): the cloud is the only refresher, and the
 * host holds an access token in memory until it expires, and nothing else. The
 * calls go to the account plane with the person's delegated token as the bearer
 * (`AccountReads`), as the account connection reads do.
 */

export type CloudCredentialRead =
  | { kind: 'ok'; delivery: ProfileCredentialDelivery }
  /** The cloud holds no connection for this person and server: the person signs in. */
  | { kind: 'not-connected' }
  /** The cloud's refresh was refused: the person signs in again. */
  | { kind: 'reconnect-required' }
  /** This host cannot ask: unlinked, or no delegation for the person. */
  | { kind: 'no-executor' }
  | { kind: 'unreachable' }

export type CloudCredentialUpload =
  | { kind: 'uploaded'; version: number }
  /** The cloud already holds one: it wins. */
  | { kind: 'held'; currentVersion: number | null }
  /** The cloud could not prove the material works (422): the host keeps its copy. */
  | { kind: 'refused' }
  | { kind: 'no-executor' }
  | { kind: 'unreachable' }

export interface CloudCredentialsDeps {
  reads: Pick<AccountReads, 'fetch'>
  /** The account a credential key is read as: the person, or for the host's own (null), its owner; null when there is none. */
  userFor: (credentialUserId: string | null) => string | null
  now?: () => number
}

interface Cached {
  delivery: ProfileCredentialDelivery
}

/** The body of a read or an upload. */
type CredentialCall =
  | { serverUrl: string }
  | { serverUrl: string; expectedVersion: number | null; credential: ProfileCredential; label: string | null }

function cacheKey(credentialUserId: string | null, serverUrl: string): string {
  return `${credentialUserId ?? ''}\u0000${serverUrl}`
}

export class CloudIntegrationCredentials {
  private readonly cache = new Map<string, Cached>()
  private readonly reading = new Map<string, Promise<CloudCredentialRead>>()

  constructor(private readonly deps: CloudCredentialsDeps) {}

  /** The current authorization for a call, from the cache while it lasts, else from the cloud. */
  read(credentialUserId: string | null, serverUrl: string): Promise<CloudCredentialRead> {
    const key = cacheKey(credentialUserId, serverUrl)
    const cached = this.cache.get(key)
    const now = (this.deps.now ?? Date.now)()
    if (cached && (cached.delivery.expiresAt === null || cached.delivery.expiresAt - now > RENEWAL_MARGIN_MS)) {
      return Promise.resolve({ kind: 'ok', delivery: cached.delivery })
    }
    const pending = this.reading.get(key)
    if (pending) return pending
    const read = this.fetchDelivery(credentialUserId, serverUrl).finally(() => this.reading.delete(key))
    this.reading.set(key, read)
    return read
  }

  /** Whether a token is still in the cache, for the moment the cloud does not answer. */
  cached(credentialUserId: string | null, serverUrl: string): ProfileCredentialDelivery | null {
    const cached = this.cache.get(cacheKey(credentialUserId, serverUrl))
    const now = (this.deps.now ?? Date.now)()
    return cached && (cached.delivery.expiresAt === null || cached.delivery.expiresAt > now) ? cached.delivery : null
  }

  forget(credentialUserId: string | null, serverUrl: string): void {
    this.cache.delete(cacheKey(credentialUserId, serverUrl))
  }

  /** A delegation ended (sign-out, removal): no credential it brought may be used again; the next call reads the cloud. */
  clear(): void {
    this.cache.clear()
  }

  /** The reconcile upload (§5.4): once, with `expectedVersion: null`. */
  async upload(credentialUserId: string | null, serverUrl: string, credential: ProfileCredential, label: string | null): Promise<CloudCredentialUpload> {
    const call = await this.call(credentialUserId, 'PUT', { serverUrl, expectedVersion: null, credential, label })
    if (call.kind !== 'response') return call
    const response = call.response
    const body: unknown = await response.json().catch(() => null)
    if (response.status === 201 || response.status === 200) {
      const parsed = profileCredentialUploadResponseSchema.safeParse(body)
      if (parsed.success) {
        log.info('integration_credential_uploaded', { credentialUserId, version: parsed.data.version })
        return { kind: 'uploaded', version: parsed.data.version }
      }
    }
    if (response.status === 409) {
      const parsed = profileCredentialConflictBodySchema.safeParse(body)
      return { kind: 'held', currentVersion: parsed.success ? parsed.data.currentVersion : null }
    }
    if (response.status === 422) return { kind: 'refused' }
    log.warn('integration_credential_upload_failed', { credentialUserId, status: response.status })
    return { kind: 'unreachable' }
  }

  private async fetchDelivery(credentialUserId: string | null, serverUrl: string): Promise<CloudCredentialRead> {
    const call = await this.call(credentialUserId, 'POST', { serverUrl })
    if (call.kind !== 'response') return call
    const response = call.response
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const parsed = profileCredentialDeliverySchema.safeParse(body)
      if (parsed.success) {
        this.cache.set(cacheKey(credentialUserId, serverUrl), { delivery: parsed.data })
        return { kind: 'ok', delivery: parsed.data }
      }
      log.warn('integration_credential_unreadable', { credentialUserId })
      return { kind: 'unreachable' }
    }
    if (response.status === 404) {
      this.forget(credentialUserId, serverUrl)
      return { kind: 'not-connected' }
    }
    if (response.status === 409) {
      this.forget(credentialUserId, serverUrl)
      return { kind: 'reconnect-required' }
    }
    log.warn('integration_credential_read_failed', { credentialUserId, status: response.status })
    return { kind: 'unreachable' }
  }

  private async call(credentialUserId: string | null, method: 'POST' | 'PUT', body: CredentialCall): Promise<{ kind: 'response'; response: Response } | { kind: 'no-executor' } | { kind: 'unreachable' }> {
    const userId = this.deps.userFor(credentialUserId)
    if (!userId) return { kind: 'no-executor' }
    const response = await this.deps.reads.fetch(userId, null, PROFILE_CREDENTIAL_PATH, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (response instanceof Response) return { kind: 'response', response }
    if (response.refused !== 'UNREACHABLE') return { kind: 'no-executor' }
    log.warn('integration_credential_cloud_unreachable', { error: response.message })
    return { kind: 'unreachable' }
  }
}
