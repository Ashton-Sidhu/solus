import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { QueueDrain } from '@solus/server/server/uplink/queue-drain'
import type { RunnerCallResult, RunnerGrantInfo } from '@solus/server/server/uplink/runner-delivery'
import { RUNNER_QUEUE_CLAIM_PATH, RUNNER_QUEUE_SETTLE_PATH, type ClaimedPrompt, type RunnerQueueSettleRequest } from '@solus/server/server/uplink/runner-protocol'
import type { TurnActor } from '@solus/server/sessions/turn-ledger'

// docs/plans/cloud-service-model.md §4: the runner claims what waited for its
// sessions, runs each prompt as its author's turn on the author's seat, and
// settles it under the claimed epoch — once, whatever the service hands back.

const GRANT: RunnerGrantInfo = { hostId: 'runner-1', organizationId: 'org1', workspaceUrl: 'https://workspace.test', ownerUserId: 'alice' }

function prompt(queueId: string, author: ClaimedPrompt['author'], sessionId = 's1'): ClaimedPrompt {
  return { queueId, sessionId, epoch: 1, text: `text ${queueId}`, author, createdAt: 1 }
}

/** The delivery as the drain sees it: a grant it announces, cycles it runs, and the two queue routes. */
class FakeDelivery {
  batches: ClaimedPrompt[][] = []
  settlements: RunnerQueueSettleRequest[] = []
  claims = 0
  kicks = 0
  claimAnswer: RunnerCallResult<unknown> | null = null
  private grantListener: ((info: RunnerGrantInfo | null) => void) | null = null
  private cycleListener: (() => Promise<void> | void) | null = null

  async call<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<RunnerCallResult<T>> {
    if (path === RUNNER_QUEUE_CLAIM_PATH) {
      this.claims += 1
      if (this.claimAnswer) return this.claimAnswer as RunnerCallResult<T>
      return { kind: 'ok', body: schema.parse({ prompts: this.batches.shift() ?? [] }) }
    }
    if (path === RUNNER_QUEUE_SETTLE_PATH) {
      this.settlements.push(body as RunnerQueueSettleRequest)
      return { kind: 'ok', body: schema.parse({ settled: true }) }
    }
    throw new Error(`unexpected path ${path}`)
  }

  onGrant(listener: (info: RunnerGrantInfo | null) => void): () => void {
    this.grantListener = listener
    listener(null)
    return () => { this.grantListener = null }
  }

  onCycle(listener: () => Promise<void> | void): () => void {
    this.cycleListener = listener
    return () => { this.cycleListener = null }
  }

  kick(): void {
    this.kicks += 1
  }

  grant(info: RunnerGrantInfo | null): void {
    this.grantListener?.(info)
  }

  async cycle(): Promise<void> {
    await this.cycleListener?.()
  }
}

interface Harness {
  delivery: FakeDelivery
  drain: QueueDrain
  dispatched: Array<{ sessionId: string; text: string; actor: TurnActor }>
  intervals: number
  clears: number
}

function harness(options: { fail?: (sessionId: string) => Error | null; holds?: (sessionId: string) => boolean } = {}): Harness {
  const delivery = new FakeDelivery()
  const state: Harness = { delivery, dispatched: [], intervals: 0, clears: 0, drain: null as unknown as QueueDrain }
  state.drain = new QueueDrain({
    delivery,
    holdsSession: options.holds ?? (() => true),
    promptSession: async (sessionId, text, actor) => {
      const error = options.fail?.(sessionId)
      if (error) throw error
      state.dispatched.push({ sessionId, text, actor })
      return { disposition: 'started' }
    },
    setIntervalFn: (() => { state.intervals += 1; return { unref() {} } }) as unknown as typeof setInterval,
    clearIntervalFn: (() => { state.clears += 1 }) as unknown as typeof clearInterval,
  })
  state.drain.start()
  return state
}

describe('queue drain', () => {
  test('nothing is claimed without a grant; with one, every cycle claims and each prompt runs as its author on the author\'s seat', async () => {
    const { delivery, drain, dispatched, intervals } = harness()
    delivery.batches.push([prompt('q1', { userId: 'alice', displayName: 'Alice' }), prompt('q2', { userId: 'bob', displayName: 'Bob' }, 's2')])
    await delivery.cycle()
    expect(delivery.claims).toBe(0)
    expect(intervals).toBe(0)

    delivery.grant(GRANT)
    await delivery.cycle()
    expect(delivery.claims).toBe(1)
    // WHY: the account that linked the runner is the host's own login, so its
    // turns run on the host seat; a colleague's turns run on their own seat, and
    // the ledger records who asked either way.
    expect(dispatched).toEqual([
      { sessionId: 's1', text: 'text q1', actor: { userId: 'alice', seatUserId: HOST_OWNER_USER_ID, displayName: 'Alice' } },
      { sessionId: 's2', text: 'text q2', actor: { userId: 'bob', seatUserId: 'bob', displayName: 'Bob' } },
    ])
    expect(delivery.settlements).toEqual([
      { hostId: 'runner-1', queueId: 'q1', epoch: 1, state: 'dispatched' },
      { hostId: 'runner-1', queueId: 'q2', epoch: 1, state: 'dispatched' },
    ])
    drain.stop()
  })

  test('a turn that cannot start settles failed with the reason; a session this runner does not hold is failed without a dispatch', async () => {
    const { delivery, drain, dispatched } = harness({
      fail: (sessionId) => (sessionId === 's1' ? new Error('Connect your Claude account on this host to run a turn.') : null),
      holds: (sessionId) => sessionId !== 'gone',
    })
    delivery.grant(GRANT)
    delivery.batches.push([prompt('q1', { userId: 'bob' }), prompt('q2', { userId: 'bob' }, 'gone'), prompt('q3', { userId: 'bob' }, 's2')])
    await delivery.cycle()
    expect(dispatched.map((turn) => turn.sessionId)).toEqual(['s2'])
    expect(delivery.settlements.map((settlement) => [settlement.queueId, settlement.state, settlement.error])).toEqual([
      ['q1', 'failed', 'Connect your Claude account on this host to run a turn.'],
      ['q2', 'failed', 'This runner does not hold the session.'],
      ['q3', 'dispatched', undefined],
    ])
    drain.stop()
  })

  test('a queue id handed back again is settled from memory and never dispatched twice', async () => {
    // WHY: a settlement lost on the wire leaves the claim on the service until
    // its lease runs out; when it comes back, the turn already ran.
    const { delivery, drain, dispatched } = harness()
    delivery.grant(GRANT)
    delivery.batches.push([prompt('q1', { userId: 'bob' })])
    await delivery.cycle()
    delivery.batches.push([prompt('q1', { userId: 'bob' }), prompt('q2', { userId: 'bob' })])
    await delivery.cycle()
    expect(dispatched.map((turn) => turn.text)).toEqual(['text q1', 'text q2'])
    expect(delivery.settlements.map((settlement) => settlement.queueId)).toEqual(['q1', 'q1', 'q2'])
    drain.stop()
  })

  test('a full batch is followed by another claim in the same pass; a refused claim ends the pass', async () => {
    const { delivery, drain, dispatched } = harness()
    delivery.grant(GRANT)
    const full = Array.from({ length: 10 }, (_, index) => prompt(`q${index}`, { userId: 'bob' }))
    delivery.batches.push(full, [prompt('q10', { userId: 'bob' })])
    await delivery.cycle()
    expect(delivery.claims).toBe(2)
    expect(dispatched).toHaveLength(11)

    delivery.claimAnswer = { kind: 'unreachable', error: 'down' }
    await delivery.cycle()
    expect(delivery.claims).toBe(3)
    expect(dispatched).toHaveLength(11)
    drain.stop()
  })

  test('the poll runs only while a grant is held, and stop ends it', () => {
    const state = harness()
    state.delivery.grant(GRANT)
    expect(state.intervals).toBe(1)
    state.delivery.grant(GRANT)
    expect(state.intervals).toBe(1)
    state.delivery.grant(null)
    expect(state.clears).toBe(1)
    state.delivery.grant(GRANT)
    expect(state.intervals).toBe(2)
    state.drain.stop()
    expect(state.clears).toBe(2)
  })
})
