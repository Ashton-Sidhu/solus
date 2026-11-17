import { normalizeServerUrl } from '@solus/client-core/pairing'
import { readHostHealth, refreshHostSession, type HostHealth } from '@solus/client-core/host-http'
import type { HostIntroduction, IntroducedHostsSummary } from '@solus/contracts/host-api'
import { getInstallationId, issueSessionToken, revokeDevice } from '../../admission/auth'
import { createLogger } from '../../logger'
import { hostDisplayName } from '../../platform/host-display-name'
import { readHostRecords, findHostRecord, saveHostRecord, saveHostConnection, hostCredential, removeHostConnection, removeHostListing, onHostRecordRemoved } from '../../host/host-list'
import { hostIdentity } from '../../host/host-identity'
import { newHealthNonce, routeNeedsProof } from '@solus/contracts/host-identity'
import { routeForUrl } from '@solus/contracts/host-routes'
import { verifyHostProof } from '@solus/contracts/host-proof'

const log = createLogger('orchestration', 'introduced-hosts.ts')

/** A token older than this is refreshed at the next dial, so a host in use never reaches the 30-day expiry. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 5_000
interface IntroducedHost {
  installationId: string
  label: string
  url: string
  sessionToken: string
  identityKey: string
  introducedAt: number
  refreshedAt: number
  grantedDeviceId: string
}
interface Stored {
  hosts: IntroducedHost[]
  refused: Array<{ installationId: string; label: string }>
}

/** This host, as an introduction needs it. */
export interface IntroductionSelf {
  installationId(): string
  name(): string
  /** The addresses another host may reach this one at, the widest reach first. */
  urls(): Promise<string[]>
  issueToken(deviceLabel: string): { token: string; deviceId: string }
  revokeDevice(deviceId: string): void
  identityKey(): string
}

const thisHost: IntroductionSelf = {
  installationId: getInstallationId,
  name: hostDisplayName,
  urls: async () => [],
  issueToken: issueSessionToken,
  revokeDevice,
  identityKey: () => hostIdentity().publicKey(),
}

/**
 * The hosts this host was introduced to (docs/plans/host-reach.md §4): local reach,
 * with no Solus account. A client that holds owner pairings for two hosts asks each
 * one for a token for the other (`issue`) and hands it over (`accept`), so a person's
 * hosts reach each other without anyone pairing them. The tokens stay in the secret
 * store and never reach a client after the hand-over.
 */
export class IntroducedHosts {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly self: IntroductionSelf = thisHost,
  ) {
    this.stopRemoval = onHostRecordRemoved((record) => {
      if (record.introduction) this.self.revokeDevice(record.introduction.grantedDeviceId)
    })
  }

  private readonly stopRemoval: () => void

  dispose(): void { this.stopRemoval() }

  list(): IntroducedHostsSummary {
    const { hosts, refused } = this.load()
    return {
      hosts: hosts.map(({ installationId, label, url, identityKey, introducedAt }) => ({ installationId, label, url, identityKey, introducedAt })),
      refused,
    }
  }

  /** A token for the host `forHost` names, to be handed to it. Refused for a host the person forgot here. */
  async issue(forHost: { installationId: string; label: string }): Promise<HostIntroduction> {
    if (forHost.installationId === this.self.installationId()) throw new Error('A host is not introduced to itself.')
    if (this.isRefused(forHost.installationId)) throw new Error(`${forHost.label} was forgotten on this host. Allow it again first.`)
    const issued = this.self.issueToken(`${forHost.label} (Solus host)`)
    return {
      installationId: this.self.installationId(),
      label: this.self.name(),
      urls: await this.self.urls(),
      sessionToken: issued.token,
      deviceId: issued.deviceId,
      identityKey: this.self.identityKey(),
    }
  }

  /**
   * Keeps the token another host issued for this one. It is kept only at an address
   * that answers as that host, and only after that host accepts the token, exchanged
   * for this host's own copy. `grantedDeviceId` is the device this host issued for it.
   */
  async accept(introduction: HostIntroduction, grantedDeviceId: string): Promise<void> {
    if (introduction.installationId === this.self.installationId()) throw new Error('A host is not introduced to itself.')
    if (this.isRefused(introduction.installationId)) throw new Error(`${introduction.label} was forgotten on this host. Allow it again first.`)
    for (const candidate of introduction.urls) {
      const url = normalizeServerUrl(candidate)
      const health = await this.probe(url, introduction.installationId, introduction.identityKey)
      if (!health) continue
      const sessionToken = await this.exchange(url, introduction.sessionToken)
      if (!sessionToken || sessionToken === 'refused') break
      if (this.isRefused(introduction.installationId)) break
      const now = this.now()
      this.remove(introduction.installationId, grantedDeviceId)
      this.save({ installationId: introduction.installationId, label: health.name ?? introduction.label, url, sessionToken, identityKey: introduction.identityKey, introducedAt: now, refreshedAt: now, grantedDeviceId })
      log.info('host_introduced', { installationId: introduction.installationId })
      return
    }
    // The device issued for that host is never used: it goes now.
    this.self.revokeDevice(grantedDeviceId)
    throw new Error(`This host cannot reach ${introduction.label} at ${introduction.urls.join(', ') || 'any address'}.`)
  }

  /** Forgets an introduced host here, revokes its device, and refuses it until `allow`. */
  forget(installationId: string): boolean {
    const forgotten = removeHostListing(installationId)
    if (forgotten) log.info('introduced_host_forgotten', { installationId })
    return forgotten
  }

  /** Lets clients introduce a forgotten host again. */
  allow(installationId: string): boolean {
    const record = findHostRecord(installationId)
    if (!record?.forgotten) return false
    // Allow removes the refusal; it does not restore a credential or a forward.
    saveHostRecord({ ...record, forgotten: false })
    return true
  }

  /**
   * The token for one dial, or null. The token goes only to an address that still
   * answers as the introduced host, and is refreshed when it is a day old. A host
   * that refuses the token revoked this one: it is removed here too.
   */
  async credential(installationId: string): Promise<string | null> {
    const host = this.load().hosts.find((candidate) => candidate.installationId === installationId)
    if (!host) return null
    if (!await this.probe(host.url, installationId, host.identityKey)) {
      log.warn('introduced_host_not_proven', { installationId })
      return null
    }
    if (hostCredential(installationId, 'introduction') !== host.sessionToken) return null
    if (this.now() - host.refreshedAt < REFRESH_AFTER_MS) return host.sessionToken
    const refreshed = await this.exchange(host.url, host.sessionToken)
    if (hostCredential(installationId, 'introduction') !== host.sessionToken) return null
    if (refreshed === 'refused') {
      this.remove(installationId)
      log.info('introduced_host_revoked_there', { installationId })
      return null
    }
    if (!refreshed) return host.sessionToken
    const stored = this.load()
    const kept = stored.hosts.find((candidate) => candidate.installationId === installationId)
    if (kept) {
      kept.sessionToken = refreshed
      kept.refreshedAt = this.now()
      this.save(kept)
    }
    return refreshed
  }

  private isRefused(installationId: string): boolean {
    return findHostRecord(installationId)?.forgotten ?? false
  }

  /** Removes one introduced host and revokes its device here, unless it is `keepDeviceId`. */
  private remove(installationId: string, keepDeviceId?: string): IntroducedHost | null {
    const stored = this.load()
    const host = stored.hosts.find((candidate) => candidate.installationId === installationId)
    if (!host) return null
    removeHostConnection(installationId, 'introduction')
    if (host.grantedDeviceId !== keepDeviceId) this.self.revokeDevice(host.grantedDeviceId)
    return host
  }

  /** A fresh token for `sessionToken` from the host at `url`; `refused` when the host refuses it, null when it does not answer. */
  private async exchange(url: string, sessionToken: string): Promise<string | 'refused' | null> {
    const refreshed = await refreshHostSession(this.fetchImpl, url, sessionToken, PROBE_TIMEOUT_MS)
    if (refreshed.result === 'refreshed') return refreshed.sessionToken
    if (refreshed.result === 'unauthorized') return 'refused'
    log.warn('introduced_host_refresh_failed', { url })
    return null
  }

  /** The health at `url` when it answers as `installationId` and, on an `http:` route, signs a fresh nonce with `identityKey`. */
  private async probe(url: string, installationId: string, identityKey: string): Promise<HostHealth | null> {
    const nonce = newHealthNonce()
    const health = await readHostHealth(this.fetchImpl, url, AbortSignal.timeout(PROBE_TIMEOUT_MS), nonce)
    if (!health || health.installationId !== installationId) return null
    if (!routeNeedsProof({ url })) return health
    return health.proof && verifyHostProof(identityKey, nonce, installationId, health.proof) ? health : null
  }

  private load(): Stored {
    const records = readHostRecords()
    return {
      hosts: records.flatMap(({ listing, introduction, forgotten }) => {
        const sessionToken = hostCredential(listing.installationId, 'introduction')
        if (forgotten || !introduction || !sessionToken || !listing.identityKey) return []
        return [{ ...introduction, installationId: listing.installationId, label: listing.label,
          identityKey: listing.identityKey, sessionToken }]
      }),
      refused: records.filter((record) => record.forgotten).map(({ listing }) => ({ installationId: listing.installationId, label: listing.label })),
    }
  }

  private save({ installationId, label, identityKey, sessionToken, ...settings }: IntroducedHost): void {
    saveHostConnection({ id: installationId, installationId, label, identityKey,
      lastConnected: this.now(), routes: [routeForUrl(settings.url)] },
    { kind: 'introduction', settings, token: sessionToken })
  }
}
