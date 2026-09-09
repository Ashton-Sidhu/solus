import type { HostInstallKind, HostUpdateStatus } from '@solus/contracts/host-update-types'
import type { SetupAgent } from '@solus/contracts/types'
import { createLogger } from '../logger'
import { reduceCheckState, type CheckEvent } from './check-state'
import type { LatestRelease } from './release-sources'

import { FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS } from '@solus/contracts/update-cadence'
const log = createLogger('updates', 'update-status-service.ts')
type Target = 'solus' | SetupAgent
interface UpdateServiceDeps {
  currentVersion: string
  install: HostInstallKind
  latest(target: Target): Promise<LatestRelease>
  providerVersion(agent: SetupAgent): Promise<string | null>
  publish(status: HostUpdateStatus): void
  now?: () => number
}

export class UpdateStatusService {
  status: HostUpdateStatus
  private readonly now: () => number
  private lastManualCheck = -Infinity
  private pending: Promise<HostUpdateStatus> | null = null
  private readonly providerChecks = new Map<SetupAgent, Promise<void>>()
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(private readonly deps: UpdateServiceDeps) {
    this.now = deps.now ?? Date.now
    this.status = {
      currentVersion: deps.currentVersion, install: deps.install, remediation: null, releaseUrl: null,
      check: { kind: 'idle', reason: deps.install === 'source' ? 'Development build' : deps.install === 'desktop' ? 'Updates with the Solus app.' : null },
      providers: (['claude', 'codex'] as const).map((agent) => ({ agent, installedVersion: null, check: { kind: 'idle', reason: null } })),
    }
  }

  start(): void {
    if (this.firstTimer || this.interval) return
    this.stopped = false
    this.firstTimer = setTimeout(() => { void this.check(false) }, FIRST_CHECK_DELAY_MS)
    this.interval = setInterval(() => { void this.check(false) }, CHECK_INTERVAL_MS)
    this.firstTimer.unref?.()
    this.interval.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.interval) clearInterval(this.interval)
    this.firstTimer = null
    this.interval = null
  }

  check(manual = true): Promise<HostUpdateStatus> {
    if (this.pending) return this.pending
    if (manual && this.now() - this.lastManualCheck < 60_000) return Promise.resolve(this.status)
    if (manual) this.lastManualCheck = this.now()
    this.pending = Promise.all([this.checkHost(), this.refreshProvider('claude'), this.refreshProvider('codex')])
      .then(() => this.status).finally(() => { this.pending = null })
    return this.pending
  }

  /** An install must win over a version read started before it finished. */
  async providerInstalled(agent: SetupAgent): Promise<void> {
    await this.providerChecks.get(agent)
    await this.refreshProvider(agent)
  }

  private apply(target: Target, event: CheckEvent): void {
    const provider = this.status.providers.find((entry) => entry.agent === target)
    const previous = provider ? provider.check : this.status.check
    const next = reduceCheckState(previous, event)
    if (previous === next) return
    if (provider) provider.check = next
    else this.status.check = next
    log.info('host_update_check', { target, state: next.kind, latestVersion: 'latestVersion' in next ? next.latestVersion : null })
    if (!this.stopped) this.deps.publish(structuredClone(this.status))
  }

  private async runCheck(target: Target, readCurrent: () => Promise<string | null>): Promise<void> {
    const previous = target === 'solus' ? this.status.check : this.status.providers.find((entry) => entry.agent === target)!.check
    const latestVersion = 'latestVersion' in previous ? previous.latestVersion : null
    this.apply(target, { kind: 'check' })
    try {
      const current = await readCurrent()
      const provider = this.status.providers.find((entry) => entry.agent === target)
      if (provider) provider.installedVersion = current
      if (!current) {
        this.apply(target, { kind: 'idle', reason: 'Not installed' })
        return
      }
      const latest = await this.deps.latest(target)
      if (target === 'solus') {
        this.status.releaseUrl = latest.url
        this.status.remediation = this.status.install === 'homebrew'
          ? 'Run brew upgrade solus-server on this host, then restart it.'
          : this.status.install === 'tarball' ? 'Run solus update on this host, then restart it.'
            : `Install Solus ${latest.version} on this host.`
      }
      this.apply(target, { kind: 'result', current, latest: latest.version, now: this.now() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('host_update_check_failed', { target, error: message })
      this.apply(target, { kind: 'error', message, latestVersion, now: this.now() })
    }
  }

  private async checkHost(): Promise<void> {
    if (this.status.install === 'desktop' || this.status.install === 'source') return
    await this.runCheck('solus', async () => this.status.currentVersion)
  }

  private refreshProvider(agent: SetupAgent): Promise<void> {
    const pending = this.providerChecks.get(agent)
    if (pending) return pending
    const promise = this.runCheck(agent, () => this.deps.providerVersion(agent))
      .finally(() => { this.providerChecks.delete(agent) })
    this.providerChecks.set(agent, promise)
    return promise
  }
}
