import { FIRST_PARTY_ACCESS_TOKEN_TTL_SECONDS, type HostAccessTokenResponse } from '@solus/contracts/uplink'

export const GRANT_RENEW_BEFORE_END_MS = 30 * 60 * 1000
export interface GrantOptions { fresh?: boolean }

interface Entry {
  grant: HostAccessTokenResponse | null
  pending: Promise<HostAccessTokenResponse | null> | null
}

/** In-memory grants for one account session. Its owner clears them when that session ends. */
export class HostGrantCache {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly now: () => number = Date.now) {}

  clear(): void { this.entries.clear() }

  async acquire(
    hostId: string,
    organizationId: string | undefined,
    mint: () => Promise<HostAccessTokenResponse | null>,
    options?: GrantOptions,
  ): Promise<HostAccessTokenResponse | null> {
    const key = JSON.stringify([hostId, organizationId])
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { grant: null, pending: null }
      this.entries.set(key, entry)
    }
    if (entry.pending) return entry.pending
    if (!options?.fresh && entry.grant && entry.grant.expiresAt - this.now() > GRANT_RENEW_BEFORE_END_MS) return entry.grant
    // A refused grant must not be reused if acquiring its replacement fails.
    entry.grant = null
    const current = entry
    const limit = this.now() + FIRST_PARTY_ACCESS_TOKEN_TTL_SECONDS * 1000
    const pending = (async () => {
      const grant = await mint()
      // Sign-out cleared the cache while this request was running.
      if (this.entries.get(key) !== current || !grant || grant.expiresAt <= this.now()) return null
      current.grant = { ...grant, expiresAt: Math.min(grant.expiresAt, limit) }
      return current.grant
    })().finally(() => { if (current.pending === pending) current.pending = null })
    current.pending = pending
    return pending
  }
}
