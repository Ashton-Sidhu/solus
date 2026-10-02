import { writeFile, rename } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { HostActivityReport, UplinkLinkConfig } from '@solus/contracts/uplink'
import type { FetchLike } from '../admission/access-tokens'
import { createLogger } from '../logger'
import { hostCategory } from './host-category'

const log = createLogger('main', 'managed-host-activity')

/**
 * Keeps a managed host awake while work or a foreground client needs it.
 * Cloudflare reads an atomic heartbeat file; Sprites uses its local Tasks API.
 * Both report busy state and the next scheduled run to the control plane.
 * Personal and self-hosted machines remain under their owner's control.
 */

/** The Sprites management socket (docs.fly.io/sprites/keeping-sprites-running). */
export const SPRITE_API_SOCKET = '/.sprite/api.sock'
const HOLD_TASK_PATH = '/v1/tasks/solus-work'
/** A task lives this long unless renewed: a host that dies frees the Sprite within it. */
const HOLD_EXPIRE_SECONDS = 600
const HOLD_RENEW_MS = 4 * 60_000
const REPORT_RENEW_MS = 60 * 60_000
const CHECK_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
/**
 * The machine holds itself this long before an automation is due. The control plane
 * wakes it between ten and five minutes before (its sweep runs every five minutes),
 * so the hold must start earlier than the earliest wake.
 */
export const DUE_HOLD_LEAD_MS = 15 * 60_000
/**
 * The machine stays awake this long after a client was last foregrounded. A person
 * who looks at the app must not find it paused; a short switch to another window
 * must not cost a cold start; a tab forgotten in the background must not bill all night.
 */
export const FOREGROUND_HOLD_GRACE_MS = 15 * 60_000

export interface ManagedHostActivityFacts {
  busy: boolean
  nextDueAt: number | null
  lastForegroundAt: number | null
}

/** Whether the machine must stay awake now: busy, a client foregrounded within the grace, or an automation due within the lead. */
export function shouldHold(facts: ManagedHostActivityFacts, now: number): boolean {
  return facts.busy
    || (facts.lastForegroundAt !== null && now - facts.lastForegroundAt <= FOREGROUND_HOLD_GRACE_MS)
    || (facts.nextDueAt !== null && facts.nextDueAt - now <= DUE_HOLD_LEAD_MS)
}

/** One call to the Sprites Tasks API; answers the HTTP status. */
export type SpriteTaskCall = (method: 'PUT' | 'DELETE', path: string, body?: string) => Promise<number>

export interface ManagedHostActivityDeps {
  isBusy: () => boolean
  nextDueAt: () => number | null
  /** When a client last reported it was foregrounded (its activity lease). */
  lastForegroundAt: () => number | null
  link:() => UplinkLinkConfig | null
  hostToken: () => string | null
  fetchImpl?: FetchLike
  spriteTask?: SpriteTaskCall
  now?: () => number
  /** A Cloudflare container reports its hold through an ephemeral file read by its controller. */
  activityFile?: string
}

export class ManagedHostActivity {
  private heldAt: number | null = null
  private holdFailed = false
  private reported: HostActivityReport | null = null
  private reportedAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private checking: Promise<void> | null = null

  constructor(private readonly deps: ManagedHostActivityDeps) {}

  start(): void {
    if (this.timer) return
    void this.check()
    this.timer = setInterval(() => void this.check(), CHECK_MS)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.checking
    await this.release()
  }

  /** One pass: hold or release, then report what changed. */
  check(): Promise<void> {
    this.checking ??= this.checkNow().finally(() => { this.checking = null })
    return this.checking
  }

  private async checkNow(): Promise<void> {
    if (hostCategory() !== 'managed') {
      await this.release()
      return
    }
    const now = this.now()
    const facts: ManagedHostActivityFacts = { busy: this.deps.isBusy(), nextDueAt: this.deps.nextDueAt(), lastForegroundAt: this.deps.lastForegroundAt() }
    const activityFile = this.deps.activityFile ?? (process.env.SOLUS_MANAGED_RUNTIME === 'cloudflare' ? '/run/solus-managed/activity.json' : null)
    if (activityFile) {
      try {
        // Atomic rename prevents the controller from reading a partial heartbeat.
        await writeFile(`${activityFile}.tmp`, JSON.stringify({ at: now, hold: shouldHold(facts, now), nextWakeAt: facts.nextDueAt }), { mode: 0o600 })
        await rename(`${activityFile}.tmp`, activityFile)
      } catch (error) {
        log.warn('host_activity_file_failed', { error: error instanceof Error ? error.message : String(error) })
      }
    } else if (shouldHold(facts, now)) await this.hold(now)
    else await this.release()
    await this.report({ busy: facts.busy, nextWakeAt: facts.nextDueAt }, now)
  }

  private async hold(now: number): Promise<void> {
    if (this.heldAt !== null && now - this.heldAt < HOLD_RENEW_MS) return
    const status = await this.task('PUT', HOLD_TASK_PATH, JSON.stringify({ expire: HOLD_EXPIRE_SECONDS }))
    if (status >= 200 && status < 300) {
      if (this.heldAt === null) log.info('sprite_hold_started')
      this.heldAt = now
      this.holdFailed = false
    } else if (!this.holdFailed) {
      // Logged once per failure run: a socket this user cannot open fails every pass.
      log.warn('sprite_hold_failed', { status })
      this.holdFailed = true
    }
  }

  private async release(): Promise<void> {
    if (this.heldAt === null) return
    this.heldAt = null
    const status = await this.task('DELETE', HOLD_TASK_PATH)
    // 404: the task expired already. Either way the Sprite may pause now.
    log.info('sprite_hold_released', { status })
  }

  private async report(next: HostActivityReport, now: number): Promise<void> {
    const unchanged = this.reported && this.reported.busy === next.busy && this.reported.nextWakeAt === next.nextWakeAt
    if (unchanged && now - this.reportedAt < REPORT_RENEW_MS) return
    const link = this.deps.link()
    const hostToken = link ? this.deps.hostToken() : null
    if (!link || !hostToken) return
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? fetch
    try {
      const response = await fetchImpl(`${link.directoryUrl}/v1/hosts/${link.hostId}/activity`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(next),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        log.warn('host_activity_report_refused', { status: response.status })
        return
      }
      this.reported = next
      this.reportedAt = now
    } catch (error) {
      // The next pass sends it again.
      log.warn('host_activity_report_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async task(method: 'PUT' | 'DELETE', path: string, body?: string): Promise<number> {
    try {
      return await (this.deps.spriteTask ?? spriteSocketTask)(method, path, body)
    } catch (error) {
      log.warn('sprite_task_unreachable', { method, error: error instanceof Error ? error.message : String(error) })
      return 0
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** Plain HTTP over the Sprite's management socket, virtual host `sprite`. */
const spriteSocketTask: SpriteTaskCall = (method, path, body) => new Promise((resolve, reject) => {
  const request = httpRequest({
    socketPath: SPRITE_API_SOCKET,
    host: 'sprite',
    path,
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS,
  }, (response) => {
    response.resume()
    response.on('end', () => resolve(response.statusCode ?? 0))
  })
  request.on('timeout', () => request.destroy(new Error('Sprite task request timed out')))
  request.on('error', reject)
  request.end(body)
})
