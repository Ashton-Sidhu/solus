import { describe, expect, test } from 'bun:test'
import {
  HostSupervisor,
  ladderDelayMs,
  OFFLINE_AFTER_ATTEMPTS,
  type HostPhase,
} from '@solus/client-core/host-supervisor'

function harness() {
  const dials: number[] = []
  const phases: Array<{ phase: HostPhase; attempt: number }> = []
  const pendingTimers: Array<() => void> = []
  const supervisor = new HostSupervisor({
    transport: {
      start: () => dials.push(dials.length + 1),
      probe: async () => {},
    },
    onPhaseChange: (phase, attempt) => phases.push({ phase, attempt }),
    setTimeoutFn: ((handler: () => void) => {
      pendingTimers.push(handler)
      return pendingTimers.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
    random: () => 0.5,
  })
  const runNextTimer = () => pendingTimers.shift()?.()
  return { supervisor, dials, phases, runNextTimer }
}

describe('host supervisor', () => {
  test('the ladder is the old socket.io curve: doubling, capped, jittered', () => {
    // WHY: PR 1 is a behavior-identical port — retry pacing must not change
    // out from under users the day ownership moves.
    expect(ladderDelayMs(1, () => 0.5)).toBe(1_000)
    expect(ladderDelayMs(2, () => 0.5)).toBe(2_000)
    expect(ladderDelayMs(6, () => 0.5)).toBe(30_000)
    expect(ladderDelayMs(1, () => 0)).toBe(500)
    expect(ladderDelayMs(1, () => 1)).toBe(1_500)
    expect(ladderDelayMs(20, () => 1)).toBe(30_000)
  })

  test('a drop schedules exactly one redial; acceptance resets the ladder', () => {
    const { supervisor, dials, runNextTimer } = harness()
    supervisor.start()
    expect(dials.length).toBe(1)

    supervisor.report({ kind: 'accepted', recovered: false })
    expect(supervisor.phase).toBe('connected')

    supervisor.report({ kind: 'dropped' })
    expect(supervisor.phase).toBe('reconnecting')
    expect(supervisor.attempt).toBe(1)
    runNextTimer()
    expect(dials.length).toBe(2)

    supervisor.report({ kind: 'accepted', recovered: false })
    expect(supervisor.attempt).toBe(0)
    expect(supervisor.phase).toBe('connected')
  })

  test('offline is a presentation of the running ladder, never a stop', () => {
    // WHY: the plan's phase machine — after N straight failures the row reads
    // offline, but the supervisor keeps dialling at the ladder cap.
    const { supervisor, dials, runNextTimer } = harness()
    supervisor.start()
    for (let i = 0; i < OFFLINE_AFTER_ATTEMPTS; i += 1) {
      supervisor.report({ kind: 'dial-failed' })
      runNextTimer()
    }
    expect(supervisor.phase).toBe('offline')
    const dialsAtOffline = dials.length
    supervisor.report({ kind: 'dial-failed' })
    runNextTimer()
    expect(dials.length).toBe(dialsAtOffline + 1)
  })

  test('auth block stops the ladder; dialNow is the way back', () => {
    const { supervisor, dials, runNextTimer } = harness()
    supervisor.start()
    supervisor.report({ kind: 'auth-blocked' })
    expect(supervisor.phase).toBe('blocked')
    expect(supervisor.blockedReason).toBe('auth')
    runNextTimer()
    expect(dials.length).toBe(1)

    supervisor.dialNow()
    expect(dials.length).toBe(2)
    expect(supervisor.attempt).toBe(0)
  })

  test('an identity mismatch stays blocked even through dialNow', () => {
    // WHY: dialling again cannot change who answers at that address — only
    // re-pairing can. A retry that "fixes" this would mask a hijacked host.
    const { supervisor, dials } = harness()
    supervisor.start()
    supervisor.report({ kind: 'identity-mismatch' })
    supervisor.dialNow()
    expect(supervisor.blockedReason).toBe('identity-mismatch')
    expect(dials.length).toBe(1)
  })

  test('the session generation bumps only on accepted, non-recovered connects', () => {
    // WHY: domain caches refetch on this edge. A recovered socket is the same
    // server session continuing — refetching would punish every network blip.
    const { supervisor, runNextTimer } = harness()
    supervisor.start()
    supervisor.report({ kind: 'accepted', recovered: false })
    expect(supervisor.sessionGeneration).toBe(0)

    supervisor.report({ kind: 'dropped' })
    runNextTimer()
    supervisor.report({ kind: 'accepted', recovered: true })
    expect(supervisor.sessionGeneration).toBe(0)

    supervisor.report({ kind: 'dropped' })
    runNextTimer()
    supervisor.report({ kind: 'accepted', recovered: false })
    expect(supervisor.sessionGeneration).toBe(1)
  })
})
