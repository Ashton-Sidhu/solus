import { describe, expect, test } from 'bun:test'
import { HostSupervisor, ladderDelayMs } from '@solus/client-core/host-supervisor'
import { UNREACHABLE_AFTER_MS, type LinkReadiness } from '@solus/client-core/host-readiness'

interface FakeTimer { at: number; run: () => void; cleared: boolean }

/** A supervisor on a fake clock: `advance` runs every timer that comes due. */
function harness() {
  let now = 1_000
  const dials: number[] = []
  const readings: LinkReadiness[] = []
  const unreachableCalls: boolean[] = []
  const timers: FakeTimer[] = []
  const supervisor = new HostSupervisor({
    transport: {
      start: () => dials.push(dials.length + 1),
      probe: async () => {},
      setUnreachable: (unreachable) => unreachableCalls.push(unreachable),
    },
    onReadinessChange: (readiness) => readings.push(readiness),
    setTimeoutFn: ((handler: () => void, delay: number) => {
      const timer: FakeTimer = { at: now + delay, run: handler, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeoutFn: ((timer: FakeTimer) => { timer.cleared = true }) as unknown as typeof clearTimeout,
    random: () => 0.5,
    now: () => now,
  })
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = timers.filter((timer) => !timer.cleared && timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      now = due.at
      due.cleared = true
      due.run()
    }
    now = until
  }
  return { supervisor, dials, readings, unreachableCalls, advance, now: () => now }
}

describe('host supervisor', () => {
  test('the ladder is the old socket.io curve: doubling, capped, jittered', () => {
    // WHY: retry pacing must not change out from under users when ownership moves.
    expect(ladderDelayMs(1, () => 0.5)).toBe(1_000)
    expect(ladderDelayMs(2, () => 0.5)).toBe(2_000)
    expect(ladderDelayMs(6, () => 0.5)).toBe(30_000)
    expect(ladderDelayMs(1, () => 0)).toBe(500)
    expect(ladderDelayMs(1, () => 1)).toBe(1_500)
    expect(ladderDelayMs(20, () => 1)).toBe(30_000)
  })

  test('a host never ready is checking, then unreachable after the grace', () => {
    // WHY: a loader waits only while the host may still answer. Past the grace
    // the surface must show the host's state, not a skeleton that never ends.
    const { supervisor, advance } = harness()
    supervisor.start()
    expect(supervisor.readiness).toBe('checking')
    supervisor.report({ kind: 'dial-failed' })
    expect(supervisor.readiness).toBe('checking')
    advance(UNREACHABLE_AFTER_MS - 1)
    expect(supervisor.readiness).toBe('checking')
    advance(1)
    expect(supervisor.readiness).toBe('unreachable')
    expect(supervisor.lastSeenAt).toBeNull()
  })

  test('a slow first dial that never reports is unreachable after the grace too', () => {
    // WHY: a dial can hang without an outcome; time alone ends the wait.
    const { supervisor, advance } = harness()
    supervisor.start()
    advance(UNREACHABLE_AFTER_MS)
    expect(supervisor.readiness).toBe('unreachable')
  })

  test('a drop reconnects for the grace, then is unreachable; the ladder keeps dialing', () => {
    const { supervisor, dials, advance, now } = harness()
    supervisor.start()
    supervisor.report({ kind: 'accepted', recovered: false })
    expect(supervisor.readiness).toBe('ready')
    const droppedAt = now()
    supervisor.report({ kind: 'dropped' })
    expect(supervisor.readiness).toBe('reconnecting')
    expect(supervisor.lastSeenAt).toBe(droppedAt)
    advance(UNREACHABLE_AFTER_MS)
    expect(supervisor.readiness).toBe('unreachable')
    const dialsAtUnreachable = dials.length
    supervisor.report({ kind: 'dial-failed' })
    advance(30_000)
    // Unreachable is a reading, not a stop: dials go on and do not flicker it.
    expect(dials.length).toBeGreaterThan(dialsAtUnreachable)
    expect(supervisor.readiness).toBe('unreachable')
  })

  test('a drop shorter than the grace never reads unreachable', () => {
    const { supervisor, readings, advance } = harness()
    supervisor.start()
    supervisor.report({ kind: 'accepted', recovered: false })
    supervisor.report({ kind: 'dropped' })
    advance(2_000)
    supervisor.report({ kind: 'accepted', recovered: true })
    advance(UNREACHABLE_AFTER_MS * 2)
    expect(readings).not.toContain('unreachable')
    expect(supervisor.readiness).toBe('ready')
  })

  test('the transport fails calls only while the host is unreachable', () => {
    // WHY: queued calls must reject when the host is past its grace, and queue
    // again once a retry or a reconnect gives the host another chance.
    const { supervisor, unreachableCalls, advance } = harness()
    supervisor.start()
    advance(UNREACHABLE_AFTER_MS)
    expect(unreachableCalls).toEqual([true])
    supervisor.dialNow()
    expect(unreachableCalls).toEqual([true, false])
    supervisor.report({ kind: 'accepted', recovered: false })
    expect(unreachableCalls).toEqual([true, false])
  })

  test('a user retry restarts the grace and shows the dial', () => {
    const { supervisor, dials, advance } = harness()
    supervisor.start()
    supervisor.report({ kind: 'accepted', recovered: false })
    supervisor.report({ kind: 'dropped' })
    advance(UNREACHABLE_AFTER_MS)
    expect(supervisor.readiness).toBe('unreachable')
    const before = dials.length
    supervisor.dialNow()
    expect(dials.length).toBe(before + 1)
    expect(supervisor.attempt).toBe(0)
    expect(supervisor.readiness).toBe('reconnecting')
    supervisor.report({ kind: 'dial-failed' })
    expect(supervisor.readiness).toBe('reconnecting')
    advance(UNREACHABLE_AFTER_MS)
    expect(supervisor.readiness).toBe('unreachable')
  })

  test('a host stays away through a retry until it answers', () => {
    // WHY: a surface hides the composer of a host that is away. A retry must
    // not bring it back for the length of a grace and then hide it again.
    const { supervisor, advance } = harness()
    supervisor.start()
    expect(supervisor.away).toBe(false)
    advance(UNREACHABLE_AFTER_MS)
    expect(supervisor.away).toBe(true)
    supervisor.dialNow()
    expect(supervisor.readiness).toBe('checking')
    expect(supervisor.away).toBe(true)
    supervisor.report({ kind: 'accepted', recovered: false })
    expect(supervisor.away).toBe(false)
    supervisor.report({ kind: 'dropped' })
    // A drop inside the grace is not away.
    expect(supervisor.away).toBe(false)
  })

  test('an auth refusal stops the ladder; dialNow is the way back', () => {
    const { supervisor, dials, advance } = harness()
    supervisor.start()
    supervisor.report({ kind: 'auth-blocked' })
    expect(supervisor.readiness).toBe('refused')
    expect(supervisor.refusedReason).toBe('auth')
    advance(UNREACHABLE_AFTER_MS * 3)
    expect(dials.length).toBe(1)
    expect(supervisor.readiness).toBe('refused')

    supervisor.dialNow()
    expect(dials.length).toBe(2)
    expect(supervisor.attempt).toBe(0)
    expect(supervisor.readiness).toBe('checking')
  })

  test('an identity mismatch stays refused even through dialNow', () => {
    // WHY: dialling again cannot change who answers at that address — only
    // re-pairing can. A retry that "fixes" this would mask a hijacked host.
    const { supervisor, dials } = harness()
    supervisor.start()
    supervisor.report({ kind: 'identity-mismatch' })
    supervisor.dialNow()
    expect(supervisor.refusedReason).toBe('identity-mismatch')
    expect(supervisor.readiness).toBe('refused')
    expect(dials.length).toBe(1)
  })

  test('the session generation bumps only on accepted, non-recovered connects', () => {
    // WHY: domain caches refetch on this edge. A recovered socket is the same
    // server session continuing — refetching would punish every network blip.
    const { supervisor, advance } = harness()
    supervisor.start()
    supervisor.report({ kind: 'accepted', recovered: false })
    expect(supervisor.sessionGeneration).toBe(0)

    supervisor.report({ kind: 'dropped' })
    advance(1_000)
    supervisor.report({ kind: 'accepted', recovered: true })
    expect(supervisor.sessionGeneration).toBe(0)

    supervisor.report({ kind: 'dropped' })
    advance(1_000)
    supervisor.report({ kind: 'accepted', recovered: false })
    expect(supervisor.sessionGeneration).toBe(1)
  })

  test('reports each server-session edge so host facts reload or clear', () => {
    // WHY: host facts (docs/plans/host-model.md) reload on a fresh session,
    // keep their answers on a recovered one, and clear capabilities on a drop.
    const changes: string[] = []
    const supervisor = new HostSupervisor({
      transport: { start: () => {}, probe: async () => {}, setUnreachable: () => {} },
      onSessionChange: (change) => changes.push(change),
      setTimeoutFn: (() => 0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    })
    supervisor.start()
    supervisor.report({ kind: 'accepted', recovered: true })
    supervisor.report({ kind: 'dropped' })
    supervisor.report({ kind: 'accepted', recovered: true })
    supervisor.report({ kind: 'dropped' })
    supervisor.report({ kind: 'accepted', recovered: false })
    supervisor.report({ kind: 'auth-blocked' })
    // The first accept is always fresh: there was no session to recover.
    expect(changes).toEqual(['fresh', 'lost', 'recovered', 'lost', 'fresh', 'lost'])
  })
})
