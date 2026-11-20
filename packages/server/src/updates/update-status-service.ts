import type { HostInstallKind, HostUpdateStatus } from '@solus/contracts/host-update-types'
import { isServerUpdateActive, type ServerUpdateSupport } from '@solus/contracts/server-update'
import { FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS } from '@solus/contracts/update-cadence'
import type { SetupAgent } from '@solus/contracts/types'
import { createLogger } from '../logger'
import { AgentSoftware } from './agent-software'
import { ClaudeSoftwareAdapter } from './claude-software-adapter'
import { CodexSoftwareAdapter } from './codex-software-adapter'
import { reduceCheckState } from './check-state'
import type { LatestRelease } from './release-sources'

const log = createLogger('updates', 'update-status-service.ts')
interface UpdateServiceDeps {
  currentVersion: string
  install: HostInstallKind
  latest(): Promise<LatestRelease>
  agents?: Readonly<Record<SetupAgent, AgentSoftware>>
  automaticUpdates?: () => boolean
  canCheck?: () => boolean
  assertInstallAllowed?: () => void
  publish(status: HostUpdateStatus): void
  now?: () => number
}

/** Schedules host checks and publishes the two agent modules' status. */
export class UpdateStatusService {
  readonly status: HostUpdateStatus
  readonly agents: Readonly<Record<SetupAgent, AgentSoftware>>
  private readonly now: () => number
  private lastManualCheck = -Infinity
  private pending: Promise<HostUpdateStatus> | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(private readonly deps: UpdateServiceDeps) {
    this.now = deps.now ?? Date.now
    this.status = {
      currentVersion: deps.currentVersion, install: deps.install, remediation: null, releaseUrl: null,
      check: { kind: 'idle', reason: deps.install === 'source' ? 'Development build' : deps.install === 'desktop' ? 'Updates with the Solus app.' : deps.install === 'cloud' ? 'Kept up to date by Solus cloud.' : null },
      providers: [],
    }
    const options = {
      now: deps.now,
      automatic: deps.automaticUpdates,
      canCheck: this.canCheck,
      canInstall: () => this.canCheck() && !isServerUpdateActive(this.status.serverUpdate?.operation),
      assertInstallAllowed: () => {
        deps.assertInstallAllowed?.()
        if (deps.install === 'cloud') throw new Error('Agent software on this host is updated by Solus Cloud.')
      },
    }
    this.agents = deps.agents ?? { claude: new AgentSoftware(new ClaudeSoftwareAdapter(), options), codex: new AgentSoftware(new CodexSoftwareAdapter(), options) }
    for (const agent of Object.values(this.agents)) {
      this.status.providers.push(agent.status)
      agent.on('changed', () => this.publish())
    }
  }

  get isUpdatingAgents(): boolean { return Object.values(this.agents).some((agent) => agent.isUpdating) }

  setServerUpdate(support: ServerUpdateSupport): void {
    this.status.serverUpdate = support
    this.publish()
  }

  start(): void {
    if (this.firstTimer || this.interval || this.deps.install === 'cloud') return
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
    if (!this.canCheck()) return Promise.resolve(this.status)
    if (this.pending) return this.pending
    if (manual && this.now() - this.lastManualCheck < 60_000) return Promise.resolve(this.status)
    if (manual) this.lastManualCheck = this.now()
    this.pending = Promise.all([this.checkHost(), this.refreshProviders()])
      .then(() => this.status).finally(() => { this.pending = null })
    return this.pending
  }

  /** A changed model list can require a newer agent before the next schedule. */
  async refreshProviders(): Promise<void> {
    if (!this.canCheck()) return
    await Promise.all(Object.values(this.agents).map((agent) => agent.check()))
  }

  refreshInstallations(): void {
    if (this.deps.install !== 'cloud') for (const agent of Object.values(this.agents)) agent.refreshInstallation()
  }

  private readonly canCheck = (): boolean => !this.stopped && this.deps.install !== 'cloud' && this.deps.canCheck?.() !== false

  private publish(): void {
    if (!this.stopped) this.deps.publish(structuredClone(this.status))
  }

  private async checkHost(): Promise<void> {
    if (this.deps.install === 'desktop' || this.deps.install === 'source') return
    const previous = this.status.check
    const latestVersion = 'latestVersion' in previous ? previous.latestVersion : null
    this.status.check = { kind: 'checking' }
    this.publish()
    try {
      const latest = await this.deps.latest()
      this.status.releaseUrl = latest.url
      this.status.remediation = this.status.install === 'managed'
        ? 'Run solus update on this host, or use Update Solus from a connected client.'
        : `Install Solus ${latest.version} on this host.`
      this.status.check = reduceCheckState(this.status.check, { kind: 'result', current: this.status.currentVersion, latest: latest.version, now: this.now() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('host_update_check_failed', { target: 'solus', error: message })
      this.status.check = { kind: 'error', message, latestVersion, checkedAt: this.now() }
    }
    this.publish()
  }
}
