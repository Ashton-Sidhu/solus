import { join } from 'path'
import { z } from 'zod'
import { normalizeServerUrl, pairServer } from '@solus/client-core/pairing'
import type { PairedHostSummary } from '@solus/contracts/host-api'
import { getInstallationId } from '../../admission/auth'
import { createLogger } from '../../logger'
import { dataDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'

const log = createLogger('orchestration', 'paired-hosts.ts')

/** A token older than this is refreshed at the next dial, so a host in use never reaches the 30-day expiry. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 5_000
const PAIR_TIMEOUT_MS = 15_000
const SECRET_KEY = 'paired-hosts'

const pairedHostSchema = z.object({
  installationId: z.string().min(1),
  label: z.string(),
  url: z.string().min(1),
  sessionToken: z.string().min(1),
  pairedAt: z.number(),
  refreshedAt: z.number(),
})
type PairedHost = z.infer<typeof pairedHostSchema>
const pairedHostsSchema = z.array(pairedHostSchema)

const healthSchema = z.object({ installationId: z.string().min(1), name: z.string().optional().catch(undefined) })
const refreshSchema = z.object({ sessionToken: z.string().min(1) })

/**
 * The hosts this host paired with, as a client pairs (docs/plans/cross-host-sessions.md §10).
 * Host A holds a pairing token for each one; host B lists host A as a device and
 * revokes it there. The tokens stay in the secret store and never leave this host.
 */
export class PairedHosts {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly selfInstallationId: () => string = getInstallationId,
  ) {}

  list(): PairedHostSummary[] {
    return this.load().map(({ installationId, label, url, pairedAt }) => ({ installationId, label, url, pairedAt }))
  }

  /** Pairs with the host at `url` using the code it shows. Pairing again replaces the earlier token. */
  async pair(input: { url: string; code: string }, deviceLabel: string): Promise<PairedHostSummary> {
    const url = normalizeServerUrl(input.url)
    const health = await this.probe(url)
    if (!health) throw new Error(`No Solus host answered at ${url}.`)
    if (health.installationId === this.selfInstallationId()) throw new Error('That address is this host. Pair with another host.')
    const paired = await pairServer({
      url,
      pairToken: input.code.trim(),
      deviceLabel,
      reportedName: health.name,
      fetchImpl: (request, init) => this.fetchImpl(request, { ...init, signal: AbortSignal.timeout(PAIR_TIMEOUT_MS) }),
    })
    if (paired.installationId !== health.installationId) throw new Error(`The host at ${url} changed during pairing. Try again.`)
    const now = this.now()
    const host: PairedHost = {
      installationId: paired.installationId,
      label: paired.server.label,
      url,
      sessionToken: paired.sessionToken,
      pairedAt: now,
      refreshedAt: now,
    }
    this.save([...this.load().filter((existing) => existing.installationId !== host.installationId), host])
    log.info('paired_host_added', { installationId: host.installationId })
    return { installationId: host.installationId, label: host.label, url: host.url, pairedAt: host.pairedAt }
  }

  /** Forgets the token here. Host B still lists this host as a device until it is revoked there. */
  forget(installationId: string): boolean {
    const hosts = this.load()
    const kept = hosts.filter((host) => host.installationId !== installationId)
    if (kept.length === hosts.length) return false
    this.save(kept)
    log.info('paired_host_forgotten', { installationId })
    return true
  }

  /**
   * The token for one dial, or null. The token goes only to an address that
   * still answers as the paired host, and is refreshed when it is a day old.
   */
  async credential(installationId: string): Promise<string | null> {
    const host = this.load().find((candidate) => candidate.installationId === installationId)
    if (!host) return null
    const health = await this.probe(host.url)
    if (health?.installationId !== installationId) {
      if (health) log.warn('paired_host_identity_mismatch', { installationId, answered: health.installationId })
      return null
    }
    if (this.now() - host.refreshedAt < REFRESH_AFTER_MS) return host.sessionToken
    return (await this.refresh(host)) ?? host.sessionToken
  }

  private async refresh(host: PairedHost): Promise<string | null> {
    try {
      const response = await this.fetchImpl(`${host.url}/auth/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${host.sessionToken}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!response.ok) {
        log.warn('paired_host_refresh_refused', { installationId: host.installationId, status: response.status })
        return null
      }
      const body = refreshSchema.parse(await response.json())
      const refreshedAt = this.now()
      this.save(this.load().map((existing) => existing.installationId === host.installationId
        ? { ...existing, sessionToken: body.sessionToken, refreshedAt }
        : existing))
      return body.sessionToken
    } catch (error) {
      log.warn('paired_host_refresh_failed', { installationId: host.installationId, error: String(error) })
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

  private load(): PairedHost[] {
    return secretStore().loadJson(SECRET_KEY, secretFile(), pairedHostsSchema) ?? []
  }

  private save(hosts: PairedHost[]): void {
    secretStore().saveJson(SECRET_KEY, secretFile(), hosts)
  }
}

function secretFile(): string {
  return join(dataDir(), 'paired-hosts.bin')
}
