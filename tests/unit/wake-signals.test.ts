import { describe, expect, test } from 'bun:test'
import { classifyVisibilityReturn, MEANINGFUL_SUSPENSION_MS } from '@solus/client-core/wake-signals'
import { HostSupervisor } from '@solus/client-core/host-supervisor'

function harness() {
  const dials: string[] = []
  let probes = 0
  let failProbe = false
  const pendingTimers: Array<() => void> = []
  const supervisor = new HostSupervisor({
    transport: {
      start: () => dials.push('dial'),
      probe: async () => {
        probes += 1
        if (failProbe) throw new Error('probe timed out')
      },
    },
    setTimeoutFn: ((handler: () => void) => {
      pendingTimers.push(handler)
      return pendingTimers.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
    random: () => 0.5,
  })
  return {
    supervisor,
    dials,
    probeCount: () => probes,
    setProbeFails: (fails: boolean) => (failProbe = fails),
    hasPendingTimer: () => pendingTimers.length > 0,
    runNextTimer: () => pendingTimers.shift()?.(),
  }
}

describe('wake taxonomy', () => {
  test('a short hide is an activation; a meaningful suspension is a resume', () => {
    expect(classifyVisibilityReturn(1_000)).toBe('activation')
    expect(classifyVisibilityReturn(MEANINGFUL_SUSPENSION_MS)).toBe('resume')
  })

  test('foregrounding probes a healthy host instead of reconnecting it', async () => {
    // WHY: step-3 rider — tearing down a working socket on every tab switch
    // is the thrash this taxonomy exists to end.
    const { supervisor, dials, probeCount } = harness()
    supervisor.start()
    supervisor.report({ kind: 'accepted', recovered: false })
    const dialsBefore = dials.length

    supervisor.handleWakeSignal('activation')
    await Promise.resolve()

    expect(probeCount()).toBe(1)
    expect(dials.length).toBe(dialsBefore)
  })

  test('only a resume resets the retry ladder; activation pulls the dial forward at its rung', () => {
    const { supervisor, runNextTimer } = harness()
    supervisor.start()
    supervisor.report({ kind: 'dial-failed' })
    runNextTimer()
    supervisor.report({ kind: 'dial-failed' })
    expect(supervisor.attempt).toBe(2)

    // Activation with a scheduled retry: dial now, same rung.
    supervisor.handleWakeSignal('activation')
    expect(supervisor.attempt).toBe(2)

    supervisor.report({ kind: 'dial-failed' })
    supervisor.handleWakeSignal('resume')
    expect(supervisor.attempt).toBe(0)
  })

  test('a plain activation is ignored while a dial is in flight', () => {
    // WHY: the old onOnline handler aborted an in-flight dial to start
    // another — the exact thrash the rider names.
    const { supervisor, dials } = harness()
    supervisor.start()
    expect(dials.length).toBe(1)

    supervisor.handleWakeSignal('activation')
    expect(dials.length).toBe(1)
  })

  test('a failed probe is fresh evidence: the host redials from rung zero', async () => {
    const { supervisor, dials, setProbeFails } = harness()
    supervisor.start()
    supervisor.report({ kind: 'accepted', recovered: false })
    setProbeFails(true)
    const dialsBefore = dials.length

    supervisor.handleWakeSignal('activation')
    await Promise.resolve()
    await Promise.resolve()

    expect(dials.length).toBe(dialsBefore + 1)
    expect(supervisor.attempt).toBe(0)
  })
})
