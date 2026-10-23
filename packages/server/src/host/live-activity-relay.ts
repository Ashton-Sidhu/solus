import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { agentActivityRowStatus, liveActivityRegistrationSchema, type LiveActivityRegistration } from '@solus/contracts/live-activity'
import type { SessionStatus } from '@solus/contracts/types'
import { agentActivityRowSchema, isLiveAgentActivityPhase, type AgentActivityRow, type HostRegistration, type LiveActivityReport } from '@solus/contracts/uplink'
import type { FetchLike } from '../admission/access-tokens'
import type { HostCredential } from './host-credential'
import { createLogger } from '../logger'
import { fetchAccountPlane } from './account-plane'

const log = createLogger('main', 'live-activity-relay')

/**
 * The phone's iOS Live Activity while the phone is suspended
 * (docs/plans/live-activity-push.md). The phone gives this host its card and the
 * card's push token; when a session on that card changes status here, the host
 * reports its rows to the control plane, which merges every host's rows into the
 * card and sends it through APNs. A host that is not registered with the control
 * plane cannot report: the card then goes stale on the phone, as it did before.
 *
 * Registrations are saved to a file: a suspended phone cannot give them again,
 * so a host that restarts keeps reporting the cards it had.
 */

/** ActivityKit ends a card after eight hours. */
const REGISTRATION_TTL_MS = 8 * 60 * 60_000
/** A turn's statuses arrive in a burst (running, background, completed): one report. */
const REPORT_DELAY_MS = 300
const REQUEST_TIMEOUT_MS = 15_000
/**
 * A card with a live row is reported again this often, so the control plane moves
 * its stale date (ten minutes) while a long turn sends no new status.
 */
const LIVE_REPORT_INTERVAL_MS = 5 * 60_000

const cardRegistrationSchema = liveActivityRegistrationSchema.extend({
  /** This host's rows of the card, as they are now. */
  rows: z.array(agentActivityRowSchema),
  expiresAt: z.number(),
})
type CardRegistration = z.infer<typeof cardRegistrationSchema>
const savedCardsSchema = z.array(cardRegistrationSchema)

export interface LiveActivityRelayDeps {
  /** A session's live status, or null when it is not running here. */
  statusOf: (sessionId: string) => SessionStatus | null
  registration: () => HostRegistration | null
  credential: () => Pick<HostCredential, 'hostAccessToken'> | null
  /** The file that keeps the registrations across a restart. */
  savePath?: string
  fetchImpl?: FetchLike
  now?: () => number
}

export class LiveActivityRelay {
  /** By push token. */
  private readonly cards = new Map<string, CardRegistration>()
  private readonly pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly liveReports: ReturnType<typeof setInterval>

  constructor(private readonly deps: LiveActivityRelayDeps) {
    this.load()
    this.liveReports = setInterval(() => this.reportLiveCards(), LIVE_REPORT_INTERVAL_MS)
    this.liveReports.unref?.()
  }

  register(registration: LiveActivityRegistration): void {
    const existing = this.cards.get(registration.pushToken)
    if (existing && existing.generation >= registration.generation) return
    const rows = registration.card.activities.filter((row) => row.hostId === registration.hostId).map((row) => ({ ...row }))
    if (rows.length === 0) {
      this.unregister(registration.pushToken)
      return
    }
    this.cards.set(registration.pushToken, { ...registration, rows, expiresAt: this.now() + REGISTRATION_TTL_MS })
    // The phone may have missed a change: correct the card at once.
    let changed = false
    for (const row of rows) {
      const status = this.deps.statusOf(row.sessionId)
      if (status && this.apply(row, status)) changed = true
    }
    if (changed) this.schedule(registration.pushToken)
    this.save()
  }

  unregister(pushToken: string): void {
    if (!this.cards.delete(pushToken)) return
    this.pending.delete(pushToken)
    this.save()
  }

  /** Report each card on which a session of this host is still live, changed or not. */
  reportLiveCards(): void {
    this.dropExpired()
    for (const [pushToken, card] of this.cards) {
      if (card.rows.some((row) => isLiveAgentActivityPhase(row.phase))) this.schedule(pushToken)
    }
  }

  /** A session here changed status; the phone's row may name it by either id. */
  sessionStatusChanged(event: { sessionId: string; agentSessionId: string | null; status: SessionStatus }): void {
    this.dropExpired()
    let changedAny = false
    for (const [pushToken, card] of this.cards) {
      let changed = false
      for (const row of card.rows) {
        const matches = row.sessionId === event.sessionId || row.sessionId === event.agentSessionId
        if (matches && this.apply(row, event.status)) changed = true
      }
      if (changed) this.schedule(pushToken)
      changedAny ||= changed
    }
    if (changedAny) this.save()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    clearInterval(this.liveReports)
    this.pending.clear()
  }

  private dropExpired(): void {
    const now = this.now()
    for (const [pushToken, card] of this.cards) {
      if (card.expiresAt <= now) this.unregister(pushToken)
    }
  }

  private load(): void {
    if (!this.deps.savePath) return
    let text: string
    try {
      text = readFileSync(this.deps.savePath, 'utf8')
    } catch {
      // No file yet: no card was registered.
      return
    }
    try {
      const saved = savedCardsSchema.parse(JSON.parse(text))
      for (const card of saved) this.cards.set(card.pushToken, card)
    } catch (error) {
      log.warn('live_activity_registrations_unreadable', { error: error instanceof Error ? error.message : String(error) })
    }
    this.dropExpired()
  }

  private save(): void {
    if (!this.deps.savePath) return
    // Push tokens: readable by this user only. A rename replaces the file whole.
    const temporary = `${this.deps.savePath}.tmp`
    try {
      mkdirSync(dirname(this.deps.savePath), { recursive: true })
      writeFileSync(temporary, JSON.stringify([...this.cards.values()]), { mode: 0o600 })
      renameSync(temporary, this.deps.savePath)
    } catch (error) {
      log.warn('live_activity_registrations_unsaved', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** True when the row changed. */
  private apply(row: AgentActivityRow, status: SessionStatus): boolean {
    const next = agentActivityRowStatus(status)
    if (row.phase === next.phase && row.status === next.status) return false
    row.phase = next.phase
    row.status = next.status
    row.updatedAt = new Date(this.now()).toISOString()
    return true
  }

  private schedule(pushToken: string): void {
    this.pending.add(pushToken)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const tokens = [...this.pending]
      this.pending.clear()
      for (const token of tokens) void this.report(token)
    }, REPORT_DELAY_MS)
    this.timer.unref?.()
  }

  private async report(pushToken: string): Promise<void> {
    const card = this.cards.get(pushToken)
    const registration = this.deps.registration()
    const credential = registration ? this.deps.credential() : null
    if (!card || !registration || !credential) return
    const report: LiveActivityReport = {
      pushToken,
      environment: card.environment,
      generation: card.generation,
      card: card.card,
      rows: card.rows,
    }
    try {
      const token = await credential.hostAccessToken()
      const response = await fetchAccountPlane(this.deps.fetchImpl, `${registration.directoryUrl}/v1/hosts/${registration.hostId}/live-activities`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) log.warn('live_activity_report_refused', { status: response.status })
    } catch (error) {
      // The next change reports again; the card's stale date covers the gap.
      log.warn('live_activity_report_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
