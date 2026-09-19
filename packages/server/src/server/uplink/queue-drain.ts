import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import type { SessionRunLifecycle } from '../../control-plane'
import { createLogger } from '../../logger'
import type { TurnActor } from '../../sessions/turn-ledger'
import type { RunnerDelivery, RunnerGrantInfo } from './runner-delivery'
import {
  RUNNER_QUEUE_CLAIM_PATH,
  RUNNER_QUEUE_SETTLE_PATH,
  runnerQueueClaimResponseSchema,
  runnerQueueSettleResponseSchema,
  type ClaimedPrompt,
  type RunnerQueueClaimRequest,
  type RunnerQueueSettleRequest,
} from './runner-protocol'

const log = createLogger('main', 'queue-drain')

/** How many prompts one claim takes; the runner dispatches what it takes before it asks again. */
const CLAIM_LIMIT = 10
/** How often a runner holding a grant asks the service for waiting prompts when nothing else wakes the delivery. */
const POLL_INTERVAL_MS = 15_000

export interface QueueDrainDeps {
  delivery: Pick<RunnerDelivery, 'call' | 'onGrant' | 'onCycle' | 'kick'>
  /** Whether this runner holds the session: its index or its resident sessions know it. */
  holdsSession: (sessionId: string) => boolean
  /** Dispatches the prompt as the author's turn; throws when the turn cannot start (a seat missing, a session gone). */
  promptSession: (sessionId: string, text: string, actor: TurnActor) => Promise<{ disposition: SessionRunLifecycle['disposition'] }>
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

type Settlement = Pick<RunnerQueueSettleRequest, 'state' | 'error'>

/**
 * The runner's side of the durable prompt queue
 * (docs/plans/cloud-service-model.md §4). While the delivery holds a grant, the
 * drain claims what the service queued for this runner's sessions — after every
 * idle delivery pass, and on a slow poll when nothing else wakes the delivery —
 * dispatches each prompt through the control plane as its author's turn, and
 * settles it under the epoch it was claimed with.
 *
 * A queue id is dispatched at most once per process: a claim the service hands
 * out again (its lease ran out before the settlement landed) is settled with
 * the outcome remembered here, never run a second time.
 */
export class QueueDrain {
  private grant: RunnerGrantInfo | null = null
  private draining = false
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribes: Array<() => void> = []
  private readonly outcomes = new Map<string, Settlement>()

  constructor(private readonly deps: QueueDrainDeps) {}

  start(): void {
    this.unsubscribes.push(this.deps.delivery.onGrant((info) => {
      this.grant = info
      if (info) this.startPolling()
      else this.stopPolling()
    }))
    this.unsubscribes.push(this.deps.delivery.onCycle(() => this.drain()))
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.stopPolling()
    this.grant = null
  }

  /** One pass: claim, dispatch, settle, until a claim comes back short of the limit. */
  async drain(): Promise<void> {
    if (this.draining || !this.grant) return
    this.draining = true
    try {
      for (;;) {
        const grant = this.grant
        if (!grant) return
        const body: RunnerQueueClaimRequest = { hostId: grant.hostId, limit: CLAIM_LIMIT }
        const claimed = await this.deps.delivery.call(RUNNER_QUEUE_CLAIM_PATH, body, runnerQueueClaimResponseSchema)
        if (claimed.kind !== 'ok') {
          if (claimed.kind !== 'no-grant') log.warn('queue_claim_failed', { hostId: grant.hostId, kind: claimed.kind })
          return
        }
        for (const prompt of claimed.body.prompts) await this.dispatch(grant, prompt)
        if (claimed.body.prompts.length < CLAIM_LIMIT) return
      }
    } finally {
      this.draining = false
    }
  }

  private async dispatch(grant: RunnerGrantInfo, prompt: ClaimedPrompt): Promise<void> {
    const remembered = this.outcomes.get(prompt.queueId)
    if (remembered) {
      await this.settle(grant, prompt, remembered)
      return
    }
    const settlement = await this.run(grant, prompt)
    this.outcomes.set(prompt.queueId, settlement)
    await this.settle(grant, prompt, settlement)
  }

  private async run(grant: RunnerGrantInfo, prompt: ClaimedPrompt): Promise<Settlement> {
    if (!this.deps.holdsSession(prompt.sessionId)) return { state: 'failed', error: 'This runner does not hold the session.' }
    const actor: TurnActor = {
      userId: prompt.author.userId,
      // The account that linked the runner runs on the host's own login; anyone else on their seat.
      seatUserId: prompt.author.userId === grant.ownerUserId ? HOST_OWNER_USER_ID : prompt.author.userId,
    }
    if (prompt.author.displayName) actor.displayName = prompt.author.displayName
    try {
      const { disposition } = await this.deps.promptSession(prompt.sessionId, prompt.text, actor)
      log.info('queue_prompt_dispatched', { sessionId: prompt.sessionId, queueId: prompt.queueId, disposition })
      return { state: 'dispatched' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('queue_prompt_failed', { sessionId: prompt.sessionId, queueId: prompt.queueId, error: message })
      return { state: 'failed', error: message }
    }
  }

  private async settle(grant: RunnerGrantInfo, prompt: ClaimedPrompt, settlement: Settlement): Promise<void> {
    const body: RunnerQueueSettleRequest = { hostId: grant.hostId, queueId: prompt.queueId, epoch: prompt.epoch, ...settlement }
    const answered = await this.deps.delivery.call(RUNNER_QUEUE_SETTLE_PATH, body, runnerQueueSettleResponseSchema)
    if (answered.kind !== 'ok') {
      // The claim stays on the service until its lease runs out; it comes back and is settled from memory.
      log.warn('queue_settle_failed', { queueId: prompt.queueId, kind: answered.kind })
      return
    }
    if (!answered.body.settled) log.info('queue_settle_refused', { queueId: prompt.queueId, epoch: prompt.epoch })
  }

  private startPolling(): void {
    if (this.timer) return
    const setIntervalFn = this.deps.setIntervalFn ?? setInterval
    this.timer = setIntervalFn(() => this.deps.delivery.kick(), POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  private stopPolling(): void {
    if (!this.timer) return
    const clearIntervalFn = this.deps.clearIntervalFn ?? clearInterval
    clearIntervalFn(this.timer)
    this.timer = null
  }
}
