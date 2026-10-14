import { join } from 'path'
import { z } from 'zod'
import { normalizeServerUrl } from '@solus/client-core/pairing'
import type { HostIntroduction, IntroducedHostsSummary } from '@solus/contracts/host-api'
import { getInstallationId, issueSessionToken, revokeDevice } from '../../admission/auth'
import { createLogger } from '../../logger'
import { hostDisplayName } from '../../platform/host-display-name'
import { dataDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'

const log = createLogger('orchestration', 'introduced-hosts.ts')

/** A token older than this is refreshed at the next dial, so a host in use never reaches the 30-day expiry. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 5_000
const SECRET_KEY = 'introduced-hosts'

const introducedHostSchema = z.object({
  installationId: z.string().min(1),
  label: z.string(),
  url: z.string().min(1),
  sessionToken: z.string().min(1),
  introducedAt: z.number(),
  refreshedAt: z.number(),
  /** The device on this host that the introduced host uses to reach this one. */
  grantedDeviceId: z.string().min(1),
})
type IntroducedHost = z.infer<typeof introducedHostSchema>
const storedSchema = z.object({
  hosts: z.array(introducedHostSchema),
  /** Hosts the person forgot here: no client introduces them again until they are allowed. */
  refused: z.array(z.object({ installationId: z.string().min(1), label: z.string() })),
})
type Stored = z.infer<typeof storedSchema>

const healthSchema = z.object({ installationId: z.string().min(1), name: z.string().optional().catch(undefined) })
const refreshSchema = z.object({ sessionToken: z.string().min(1) })

/** This host, as an introduction needs it. */
export interface IntroductionSelf {
  installationId(): string
  name(): string
  /** The addresses another host may reach this one at, the widest reach first. */
  urls(): Promise<string[]>
  issueToken(deviceLabel: string): { token: string; deviceId: string }
  revokeDevice(deviceId: string): void
}

const thisHost: IntroductionSelf = {
  installationId: getInstallationId,
  name: hostDisplayName,
  urls: async () => [],
  issueToken: issueSessionToken,
  revokeDevice,
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
  ) {}

  list(): IntroducedHostsSummary {
    const { hosts, refused } = this.load()
    return {
      hosts: hosts.map(({ installationId, label, url, introducedAt }) => ({ installationId, label, url, introducedAt })),
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
      const health = await this.probe(url)
      if (!health || health.installationId !== introduction.installationId) continue
      const sessionToken = await this.exchange(url, introduction.sessionToken)
      if (!sessionToken || sessionToken === 'refused') break
      const now = this.now()
      this.remove(introduction.installationId, grantedDeviceId)
      const stored = this.load()
      stored.hosts.push({ installationId: introduction.installationId, label: health.name ?? introduction.label, url, sessionToken, introducedAt: now, refreshedAt: now, grantedDeviceId })
      this.save(stored)
      log.info('host_introduced', { installationId: introduction.installationId })
      return
    }
    // The device issued for that host is never used: it goes now.
    this.self.revokeDevice(grantedDeviceId)
    throw new Error(`This host cannot reach ${introduction.label} at ${introduction.urls.join(', ') || 'any address'}.`)
  }

  /** Forgets an introduced host here, revokes its device, and refuses it until `allow`. */
  forget(installationId: string): boolean {
    const host = this.remove(installationId)
    if (!host) return false
    const stored = this.load()
    stored.refused.push({ installationId, label: host.label })
    this.save(stored)
    log.info('introduced_host_forgotten', { installationId })
    return true
  }

  /** Lets clients introduce a forgotten host again. */
  allow(installationId: string): boolean {
    const stored = this.load()
    const refused = stored.refused.filter((entry) => entry.installationId !== installationId)
    if (refused.length === stored.refused.length) return false
    this.save({ ...stored, refused })
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
    const health = await this.probe(host.url)
    if (health?.installationId !== installationId) {
      if (health) log.warn('introduced_host_identity_mismatch', { installationId, answered: health.installationId })
      return null
    }
    if (this.now() - host.refreshedAt < REFRESH_AFTER_MS) return host.sessionToken
    const refreshed = await this.exchange(host.url, host.sessionToken)
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
      this.save(stored)
    }
    return refreshed
  }

  private isRefused(installationId: string): boolean {
    return this.load().refused.some((entry) => entry.installationId === installationId)
  }

  /** Removes one introduced host and revokes its device here, unless it is `keepDeviceId`. */
  private remove(installationId: string, keepDeviceId?: string): IntroducedHost | null {
    const stored = this.load()
    const host = stored.hosts.find((candidate) => candidate.installationId === installationId)
    if (!host) return null
    this.save({ ...stored, hosts: stored.hosts.filter((candidate) => candidate !== host) })
    if (host.grantedDeviceId !== keepDeviceId) this.self.revokeDevice(host.grantedDeviceId)
    return host
  }

  /** A fresh token for `sessionToken` from the host at `url`; `refused` when the host refuses it, null when it does not answer. */
  private async exchange(url: string, sessionToken: string): Promise<string | 'refused' | null> {
    try {
      const response = await this.fetchImpl(`${url}/auth/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (response.status === 401) return 'refused'
      if (!response.ok) return null
      return refreshSchema.parse(await response.json()).sessionToken
    } catch (error) {
      log.warn('introduced_host_refresh_failed', { url, error: String(error) })
      return null
    }
  }

  private async probe(url: string): Promise<z.infer<typeof healthSchema> | null> {
    try {
      const response = await this.fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!response.ok) return null
      const parsed = healthSchema.safeParse(await response.json())
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  private load(): Stored {
    return secretStore().loadJson(SECRET_KEY, secretFile(), storedSchema) ?? { hosts: [], refused: [] }
  }

  private save(stored: Stored): void {
    secretStore().saveJson(SECRET_KEY, secretFile(), stored)
  }
}

function secretFile(): string {
  return join(dataDir(), 'introduced-hosts.bin')
}
