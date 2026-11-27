import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { AppSignalActionView, AppSignalOccurrence, AppSignalOccurredEvent } from '@solus/contracts/apps'
import type { WebhookDelivery, WebhookVerification } from '@solus/contracts/webhooks'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { SvelteRunes } from './helpers/svelte-runes'
import {
  answerStatus,
  callText,
  deliveryMark,
  deliveryTitle,
  headerRows,
  isTestDelivery,
  maskedSecret,
  webhookSummaryText,
} from '@solus/workspace-ui/components/app/manage/lib/app-webhook-deliveries'
import { SIGNAL_ADD_NODE_ID, SIGNAL_EMITTER_NODE_ID, SIGNAL_NODE_ID, actionCountText, payloadFields, payloadSummary, signalActionNodeId, signalFlow, tailCell } from '@solus/workspace-ui/components/app/manage/lib/signal-flow'

// docs/plans/apps.md §9.2: the Webhooks and Signals sections of the Manage page.

// The tail keeps its rows in `$state`: it runs on Svelte's real client runtime.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const { AppSignalTails, TAIL_LENGTH, placeOccurrence }: typeof import('@solus/workspace-ui/contexts/apps/app-signal-tail.svelte') = await import(
  runes.source('app-signal-tail', 'packages/workspace-ui/src/contexts/apps/app-signal-tail.svelte.ts', {
    'svelte/reactivity': SvelteRunes.file('node_modules/svelte/src/reactivity/index-client.js'),
    '@solus/client-core/server-connections': SvelteRunes.file('packages/client-core/src/server-connections.ts'),
    '@solus/client-core/host-events': SvelteRunes.file('packages/client-core/src/host-events.ts'),
  })
)

function occurrence(id: string, emittedAt: number, patch: Partial<AppSignalOccurrence> = {}): AppSignalOccurrence {
  return { id, name: 'report.ready', payload: '{"title":"Q3","rows":3}', emittedAt, callId: null, runId: null, deliveries: [], ...patch }
}

afterEach(() => mock.restore())

describe('the live tail of a signal', () => {
  test('an occurrence goes in at its time, an update changes it in place, and the tail keeps its length', () => {
    // WHY: a busy app emits many occurrences. The tail must not grow without end, nor rebuild its list for each one.
    const list: AppSignalOccurrence[] = []
    placeOccurrence(list, occurrence('b', 2))
    placeOccurrence(list, occurrence('c', 3))
    placeOccurrence(list, occurrence('a', 1))
    expect(list.map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
    const same = list
    placeOccurrence(list, occurrence('b', 2, { deliveries: [{ actionId: 'x', type: 'notify', status: 'delivered', detail: null }] }))
    expect(list).toBe(same)
    expect(list.map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
    expect(list[1]?.deliveries).toHaveLength(1)
    for (let index = 0; index < TAIL_LENGTH + 5; index += 1) placeOccurrence(list, occurrence(`n${index}`, 10 + index))
    expect(list).toHaveLength(TAIL_LENGTH)
    expect(list[0]?.id).toBe(`n${TAIL_LENGTH + 4}`)
  })

  test('the host pushes each occurrence to the tail of its signal, and a paused tail holds them until it goes on', async () => {
    // WHY: the owner pauses to read a row; new rows must not move it. Nothing that came is lost.
    let push: ((event: AppSignalOccurredEvent) => void) | null = null
    spyOn(serverConnections, 'serverIds').mockImplementation(() => ['a'])
    // SAFETY: the tail reads only `subscribe` of a host's events.
    spyOn(serverConnections, 'eventsFor').mockImplementation(() => ({
      subscribe: (_topic: string, handler: (event: AppSignalOccurredEvent) => void) => {
        push = handler
        return () => { push = null }
      },
    }) as never)
    // SAFETY: the tail calls only this method.
    spyOn(serverConnections, 'apiFor').mockImplementation(() => ({ appSignalOccurrences: async () => [occurrence('old', 1)] }) as Partial<HostApi> as HostApi)

    const tails = new AppSignalTails()
    const release = tails.watch('a', 'reports', 'report.ready')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const tail = tails.get('a', 'reports', 'report.ready')
    expect(tail?.occurrences.map((entry) => entry.id)).toEqual(['old'])

    push!({ appId: 'reports', occurrence: occurrence('new', 2) })
    // Another signal and another app have tails of their own.
    push!({ appId: 'reports', occurrence: occurrence('other', 3, { name: 'digest.ready' }) })
    push!({ appId: 'budget', occurrence: occurrence('elsewhere', 4) })
    expect(tail?.occurrences.map((entry) => entry.id)).toEqual(['new', 'old'])

    tails.setPaused('a', 'reports', 'report.ready', true)
    push!({ appId: 'reports', occurrence: occurrence('later', 5) })
    expect(tail?.occurrences.map((entry) => entry.id)).toEqual(['new', 'old'])
    tails.setPaused('a', 'reports', 'report.ready', false)
    expect(tail?.occurrences.map((entry) => entry.id)).toEqual(['later', 'new', 'old'])

    release()
    expect(tails.get('a', 'reports', 'report.ready')).toBeUndefined()
    expect(push).toBeNull()
  })

  test('a row says how each action ended, and a failure says why', () => {
    const ended = occurrence('a', 1, { deliveries: [
      { actionId: 'notify', type: 'notify', status: 'delivered', detail: null },
      { actionId: 'session', type: 'send_to_session', status: 'failed', detail: 'session stopped' },
      { actionId: 'limited', type: 'send_to_session', status: 'throttled', detail: null },
    ] })
    expect(tailCell(ended, 'notify')).toEqual({ text: 'Sent', mark: null, sessionId: null })
    expect(tailCell(ended, 'session')).toEqual({ text: 'Failed · session stopped', mark: 'failed', sessionId: null })
    // Over the limit did not run, but nothing is broken: a warning, not a failure.
    expect(tailCell(ended, 'limited')).toEqual({ text: 'Over the limit', mark: 'warning', sessionId: null })
    expect(tailCell(ended, 'off')).toEqual({ text: '—', mark: null, sessionId: null })
    expect(payloadSummary('{"repo":"sveltejs/kit","version":"2.48.0","notes":{"a":1}}')).toBe('sveltejs/kit 2.48.0')
    expect(payloadSummary('[1,2]')).toBe('[1,2]')
  })
})

describe('the flow of a signal', () => {
  const action = (id: string, enabled: boolean): AppSignalActionView => ({ id, signal: 'release.summarized', enabled, action: { type: 'notify', title: '', detail: '' }, delivered7d: 3, failed7d: 0 })
  const signal = (actions: AppSignalActionView[]) => ({
    name: 'release.summarized',
    count7d: 41,
    lastEmittedAt: 1000,
    payload: { type: 'object', properties: { repo: { type: 'string' }, version: { type: 'string' } } },
    emittedBy: { kind: 'workflow' as const, name: 'summarize' },
    actions,
  })

  test('left to right: what emits it, the signal, then its actions in a column centered on the signal, the same each time', () => {
    // WHY: the layout is a pure function of the signal, so the canvas draws the same flow on every load and every client.
    const flow = signalFlow(signal([action('notify', true), action('session', true)]))
    expect(flow.nodes.map((node) => [node.id, node.position.x, node.position.y])).toEqual([
      [SIGNAL_EMITTER_NODE_ID, 0, 0],
      [SIGNAL_NODE_ID, 296, 0],
      [signalActionNodeId('notify'), 632, -82],
      [signalActionNodeId('session'), 632, 0],
      [SIGNAL_ADD_NODE_ID, 632, 82],
    ])
    expect(signalFlow(signal([action('notify', true), action('session', true)]))).toEqual(flow)
    // Every action, and the node that adds one, hangs off the signal.
    expect(flow.edges.map((edge) => [edge.source, edge.target])).toEqual([
      [SIGNAL_EMITTER_NODE_ID, SIGNAL_NODE_ID],
      [SIGNAL_NODE_ID, signalActionNodeId('notify')],
      [SIGNAL_NODE_ID, signalActionNodeId('session')],
      [SIGNAL_NODE_ID, SIGNAL_ADD_NODE_ID],
    ])
    const center = flow.nodes.find((node) => node.id === SIGNAL_NODE_ID)
    expect(center?.data).toEqual({ kind: 'signal', signal: { name: 'release.summarized', count7d: 41, lastEmittedAt: 1000 }, fields: ['repo', 'version'] })
  })

  test('a signal with no action still has the node that adds one, beside the signal', () => {
    const flow = signalFlow({ ...signal([]), emittedBy: null })
    expect(flow.nodes.map((node) => [node.data.kind, node.position.y])).toEqual([['emitter', 0], ['signal', 0], ['add', 0]])
    // Before the first occurrence nothing is known to emit it: that edge is dashed, as is the one to the add node.
    expect(flow.edges.map((edge) => edge.style !== undefined)).toEqual([true, true])
    expect(flow.nodes[0].data).toEqual({ kind: 'emitter', emitter: null })
  })

  test('an action that is off stays on the canvas with its switch, and nothing reaches it', () => {
    const flow = signalFlow(signal([action('notify', true), action('off', false)]))
    const off = flow.nodes.find((node) => node.id === signalActionNodeId('off'))
    expect(off?.data).toMatchObject({ kind: 'action', action: { id: 'off', enabled: false } })
    expect(flow.edges.find((edge) => edge.target === signalActionNodeId('off'))?.style).toBeDefined()
    expect(flow.edges.find((edge) => edge.target === signalActionNodeId('notify'))?.style).toBeUndefined()
  })

  test('a narrow pane stacks the nodes top to bottom', () => {
    const flow = signalFlow(signal([action('notify', true)]), true)
    const ys = flow.nodes.map((node) => node.position.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    expect(new Set(ys).size).toBe(ys.length)
    for (const node of flow.nodes) expect(node.origin).toEqual([0, 0])
  })

  test('an action says its week, and a failure is set apart', () => {
    expect(actionCountText({ delivered7d: 41, failed7d: 0 })).toEqual({ text: '41 sent', hasFailures: false })
    expect(actionCountText({ delivered7d: 39, failed7d: 2 })).toEqual({ text: '39 sent · 2 failed', hasFailures: true })
    expect(actionCountText({ delivered7d: 0, failed7d: 0 }).text).toBe('None this week')
    expect(payloadFields({ type: 'object', properties: { repo: { type: 'string' }, version: { type: 'string' } } })).toEqual(['repo', 'version'])
    expect(payloadFields({})).toEqual([])
  })
})

describe('the deliveries of an app webhook', () => {
  const HMAC: WebhookVerification = { scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}', signature: { source: { kind: 'header', name: 'X-Hub-Signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } } }

  function delivery(patch: Partial<WebhookDelivery> = {}): WebhookDelivery {
    return {
      id: 'd1', webhookId: 'w1', receivedAt: 1, arrivedAt: 1, source: 'direct', outcome: 'ran', reason: null, replayOf: null,
      request: { method: 'POST', headers: [['content-type', 'application/json'], ['x-hub-signature-256', '[redacted]']], query: [], body: '{}', bodyIsBase64: false },
      verificationFailure: null, actions: [], ...patch,
    }
  }

  test('the status is what the receiver answered, and a refusal is never a success', () => {
    expect(answerStatus('ran')).toBe(202)
    expect(answerStatus('unverified')).toBe(401)
    expect(answerStatus('paused')).toBe(409)
    // The mark carries what the green and red status code said: a refusal is never ok.
    expect(deliveryMark('ran')).toBe('ok')
    expect(deliveryMark('unverified')).toBe('failed')
    expect(deliveryMark('partial')).toBe('failed')
    expect(deliveryMark('pending')).toBe('running')
    expect(deliveryTitle({ outcome: 'ran', replayOf: null }, 'recordRelease')).toBe('Ran recordRelease')
    expect(deliveryTitle({ outcome: 'failed', replayOf: 'd0' }, 'recordRelease')).toBe('Replay: recordRelease failed')
  })

  test('the proof header says whether it passed, and its value stays redacted', () => {
    // WHY: the log never keeps a signature; the person still sees whether the request was signed right.
    expect(headerRows(delivery(), HMAC)).toEqual([
      { name: 'content-type', value: 'application/json', check: null },
      { name: 'x-hub-signature-256', value: '[redacted]', check: 'valid' },
    ])
    expect(headerRows(delivery({ outcome: 'unverified', verificationFailure: { step: 'signature_mismatch' } }), HMAC)[1]?.check).toBe('invalid')
    expect(isTestDelivery(delivery())).toBe(false)
    expect(isTestDelivery(delivery({ request: { ...delivery().request, headers: [['x-solus-hook-test', '1']] } }))).toBe(true)
  })

  test('the head counts the week and its refusals, and the secret shows only its end', () => {
    const now = 10 * 24 * 60 * 60_000
    const list = [
      { ...delivery({ id: 'a', arrivedAt: now - 1000 }) },
      { ...delivery({ id: 'b', arrivedAt: now - 2000, outcome: 'unverified' }) },
      { ...delivery({ id: 'c', arrivedAt: now - 8 * 24 * 60 * 60_000 }) },
    ]
    expect(webhookSummaryText('recordRelease', list, 200, now)).toBe('Runs recordRelease · 2 this week, 1 refused')
    expect(webhookSummaryText('recordRelease', list.slice(0, 2), 2, now)).toBe('Runs recordRelease · 2+ this week, 1 refused')
    expect(maskedSecret('whsec_abcdefgh3f9a')).toBe('whsec_••••3f9a')
    expect(maskedSecret('plain-secret-9xyz')).toBe('••••9xyz')
    expect(callText({ actionId: 'app', type: 'call_app', status: 'started', filters: [], missing: [], durationMs: 88 }, 'recordRelease')).toBe('Started recordRelease, which answered in 88ms.')
    expect(callText(undefined, 'recordRelease')).toBe('Nothing ran: the receiver refused the request.')
  })
})
