import { describe, expect, test } from 'bun:test'
import { hostDiagnosticsText } from '@solus/client-core/host-diagnostics'
import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { hostSettingsErrorText } from '../../apps/mobile/src/features/settings/host-settings'
import { hostAsleepVeilCopy, threadHostChrome } from '../../apps/mobile/src/features/threads/lib/thread-host-chrome'
import { createHostWorld } from './helpers/native-mobile-fakes'

// A host that is away puts its thread to sleep under one statement of what
// happened, with the facts a person needs to find the cause or to send to
// support behind Details (docs/plans/host-readiness.md).

describe('host diagnostics on the phone', () => {
  test('they name the dialed address, every route, the failed dials, and the last error', async () => {
    const { registry, connections, transports, timers } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'Raiders', url: 'http://10.0.0.8:51234' }, 'ta')
    connections.connection('inst-a')
    transports[0]?.fail('dial-failed', { message: 'connect ECONNREFUSED', code: null, at: 1_000 })
    timers.runAll()

    const diagnostics = connections.diagnostics('inst-a')
    expect(diagnostics).toMatchObject({
      hostId: 'inst-a',
      label: 'Raiders',
      installationId: null,
      dialedUrl: 'http://10.0.0.8:51234',
      lastDialError: { message: 'connect ECONNREFUSED', code: null, at: 1_000 },
      clientVersion: '1.4.0',
    })
    expect(diagnostics.state).toMatchObject({ readiness: 'unreachable', away: true })
    expect(diagnostics.attempt).toBeGreaterThan(0)
    expect(diagnostics.routes.map((route) => route.url)).toEqual(['http://10.0.0.8:51234'])
    expect(hostDiagnosticsText(diagnostics)).toContain('connect ECONNREFUSED')
  })

  test('reading them never dials the host', async () => {
    // WHY: the panel and the copied text read them on every change; a read
    // that dialed would hide which dial failed and wake a host the person left.
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'Raiders', url: 'http://a:1' }, 'ta')
    const diagnostics = connections.diagnostics('inst-a')
    expect(transports).toHaveLength(0)
    expect(diagnostics).toMatchObject({ dialedUrl: null, attempt: 0, lastDialError: null })
  })

  test('the same object comes back until a value changes', async () => {
    // WHY: screens read them through useSyncExternalStore; a new object on
    // each read renders without end.
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'Raiders', url: 'http://a:1' }, 'ta')
    connections.connection('inst-a')
    const first = connections.diagnostics('inst-a')
    expect(connections.diagnostics('inst-a')).toBe(first)
    transports[0]?.fail('dial-failed', { message: 'timeout', code: null, at: 2_000 })
    const next = connections.diagnostics('inst-a')
    expect(next).not.toBe(first)
    expect(next.lastDialError?.message).toBe('timeout')
  })

  test('a host the phone no longer holds is gone', () => {
    const { connections } = createHostWorld()
    expect(connections.diagnostics('inst-x')).toMatchObject({ label: 'This host', state: { readiness: 'gone', away: true }, routes: [] })
  })
})

const away = (state: Partial<HostReadinessState>): HostReadinessState => ({
  readiness: 'unreachable',
  away: true,
  unreachableReason: 'no-answer',
  refusedReason: null,
  lastSeenAt: null,
  ...state,
})

describe('the thread for a host that is not ready', () => {
  test('inside the grace the composer stays and one whisper says the host reconnects', () => {
    // WHY: a short drop must not take the composer or a pending question
    // away, or put the thread to sleep; the whisper only says why a send may wait.
    expect(threadHostChrome({ readiness: 'reconnecting', away: false })).toEqual({ showsComposer: true, showsGraceWhisper: true, showsRequestCards: true, showsAgentsPill: true, isAsleep: false })
    expect(threadHostChrome({ readiness: 'checking', away: false })).toMatchObject({ showsGraceWhisper: true, isAsleep: false })
    expect(threadHostChrome({ readiness: 'ready', away: false })).toEqual({ showsComposer: true, showsGraceWhisper: false, showsRequestCards: true, showsAgentsPill: true, isAsleep: false })
  })

  test('a host that is away puts the thread to sleep with no composer and no whisper, also while a retry dials', () => {
    // WHY: a composer the host cannot answer only collects messages that fail,
    // so nothing takes its place: the veil over the thread says what happened.
    // A retry dials as `checking`, but the veil says so: a whisper too would
    // say it twice. The thread stays asleep until the host is ready again.
    expect(threadHostChrome({ readiness: 'unreachable', away: true })).toMatchObject({ showsComposer: false, showsGraceWhisper: false, isAsleep: true })
    expect(threadHostChrome({ readiness: 'checking', away: true })).toMatchObject({ showsComposer: false, showsGraceWhisper: false, isAsleep: true })
  })

  test('a host that is away hides the request cards and the Agents pill until it is ready', () => {
    // WHY: only the host takes an approval, an answer, or a stop. A card that
    // looks answerable while the host is away takes a reply that goes nowhere,
    // as on desktop, which hides the same cards while away.
    for (const readiness of ['unreachable', 'refused', 'checking'] as const) {
      expect(threadHostChrome({ readiness, away: true })).toMatchObject({ showsRequestCards: false, showsAgentsPill: false })
    }
    // Inside the grace a short drop must not take a pending question away.
    expect(threadHostChrome({ readiness: 'reconnecting', away: false })).toMatchObject({ showsRequestCards: true, showsAgentsPill: true })
  })

  test('the veil states what happened in the shared words, with its one action', () => {
    // WHY: desktop, web, and the phone say the same sentence for the same host
    // state. The detail promises a retry only for a host that does not answer:
    // a refused, removed, or stopped host stays away until the person acts.
    const now = 10 * 60_000
    expect(hostAsleepVeilCopy(away({ lastSeenAt: now - 4 * 60_000 }), 'Raiders', false, now)).toEqual({
      heading: 'Raiders is offline.',
      detail: 'Last seen 4 min ago. Solus keeps trying.',
      isDialing: false,
      action: 'retry',
    })
    expect(hostAsleepVeilCopy(away({ readiness: 'refused', refusedReason: 'auth', unreachableReason: null }), 'Raiders', false)).toEqual({
      heading: 'Raiders needs pairing again.',
      detail: 'The host no longer accepts this device.',
      isDialing: false,
      action: 'pair-again',
    })
    expect(hostAsleepVeilCopy(away({ unreachableReason: 'not-running' }), 'Raiders', false)).toEqual({ heading: 'Raiders is not running.', detail: null, isDialing: false, action: 'start' })
    expect(hostAsleepVeilCopy(away({ readiness: 'gone', unreachableReason: null }), 'Raiders', false)).toMatchObject({ detail: null, action: null })
  })

  test('while a retry or a start dials, the veil says so and offers no action or detail', () => {
    // WHY: a Retry during a dial starts a second dial that hides which one
    // failed; a second Start asks the account to start the machine twice. A
    // "Solus keeps trying" detail under "Trying again" says the same thing twice.
    const dialing = { heading: 'Trying Raiders again…', detail: null, isDialing: true, action: null }
    expect(hostAsleepVeilCopy(away({ readiness: 'checking' }), 'Raiders', false)).toEqual(dialing)
    expect(hostAsleepVeilCopy(away({ unreachableReason: 'not-running' }), 'Raiders', true)).toEqual(dialing)
  })
})

describe('host settings for a host that is not ready', () => {
  test('they say what happened to the host, not the transport error', () => {
    // WHY: an unreachable host fails each read with "The host d931… is
    // unreachable", which names an id and not a reason. A host that answers
    // keeps its own error, which can say what the host refused.
    expect(hostSettingsErrorText('The host d931 is unreachable', away({}), "Ashton's Mac mini")).toBe("Ashton's Mac mini is offline")
    expect(hostSettingsErrorText('The host d931 is unreachable', away({ readiness: 'checking', away: false }), 'Raiders')).toBe('Connecting to Raiders')
    expect(hostSettingsErrorText('not allowed', away({ readiness: 'ready', away: false, unreachableReason: null }), 'Raiders')).toBe('Settings could not be read: not allowed')
  })
})
