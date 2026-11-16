import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appDescriptorSchema, type AppSignalOccurredEvent } from '@solus/contracts/apps'
import type { AppRecord } from '@solus/server/data/apps/app-store'
import { DatabaseSync } from './helpers/bun-sqlite'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/apps.md §9.2, Signals: the live tail shows each occurrence as
// the app emits it, and changes its row when the actions end. The flow shows
// the week's count, what emitted the signal, and how each action did. A
// tail that read the host each second would cost every busy app; the host
// pushes each occurrence instead (`apps.signalOccurred`).

const dataDir = mkdtempSync(join(tmpdir(), 'solus-app-signal-live-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
let store: typeof import('@solus/server/data/apps/app-store')
let events: typeof import('@solus/server/apps/app-events')
let signalsModule: typeof import('@solus/server/apps/app-signals')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/apps/app-store')
  events = await import('@solus/server/apps/app-events')
  signalsModule = await import('@solus/server/apps/app-signals')
})

afterAll(async () => {
  await resetTestDatabase()
  process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const APP: AppRecord = {
  id: 'app-reports', organizationId: 'local', ownerKey: 'owner', slug: 'reports', name: 'Reports', description: '', customName: null, customDescription: null, colorHue: null, activeVersion: null,
  stopped: false, agentAccess: true, repository: '/nowhere', latestRevision: null, project: null, createdBy: { kind: 'system' }, webhookIds: {}, createdAt: 0, updatedAt: 0,
}
const DESCRIPTOR = appDescriptorSchema.parse({
  solusApp: 4,
  name: 'Reports',
  signals: [{ name: 'report.ready', description: 'A report is ready.', payload: { type: 'object', properties: { title: { type: 'string' } } } }],
})

async function eventually<Value>(read: () => Value | null, what: string): Promise<Value> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read()
    if (value !== null) return value
    await Bun.sleep(10)
  }
  throw new Error(`Timed out: ${what}`)
}

test('an occurrence reaches the live tail when it is emitted and again when its actions end, and the flow counts the week', async () => {
  const now = Date.now()
  await store.insertApp(APP)
  await store.insertVersion({
    appId: APP.id, number: 1, sourceCommit: 'a'.repeat(40), buildCommit: 'b'.repeat(40), descriptor: DESCRIPTOR,
    hasBackend: true, hasUi: false, state: 'building', error: null, buildLog: null, buildMs: null, message: 'v1', createdBy: { kind: 'system' }, createdAt: now, activations: [],
  })
  await store.activateVersion(APP, 1, { kind: 'system' })
  const app = { ...APP, activeVersion: 1 }
  await store.insertCall({ id: 'call-1', appId: APP.id, version: 1, kind: 'operation', operation: 'save', caller: { kind: 'ui' }, startedAt: now, input: null, inputTruncated: false, runId: null, traceId: null, spanId: null })

  const signals = new signalsModule.AppSignals({ record: async () => app }, {
    sendToSession: async () => { throw new Error('The target session does not exist.') },
    runAutomation: async () => 'started',
  })
  // A new signal gets one notification; the owner adds an action that fails.
  await signals.activated(app, DESCRIPTOR)
  await signals.saveAction(TEST_HANDLER_CTX, APP.id, { signal: 'report.ready', enabled: true, action: { type: 'send_to_session', sessionId: 'gone', template: '' } })

  const seen: AppSignalOccurredEvent[] = []
  const stop = events.onAppSignalOccurred((event) => seen.push(event))
  await signals.emitted(app, DESCRIPTOR, [{ name: 'report.ready', payload: { title: 'Q3' } }], { callId: 'call-1', runId: null })
  const ended = await eventually(() => seen.find((event) => event.occurrence.deliveries.length > 0) ?? null, 'the actions ended')
  stop()

  // The same occurrence twice: a tail changes its row in place.
  expect(seen).toHaveLength(2)
  expect(seen[0]).toMatchObject({ appId: APP.id, occurrence: { name: 'report.ready', payload: '{"title":"Q3"}', callId: 'call-1', deliveries: [] } })
  expect(ended.occurrence.id).toBe(seen[0]?.occurrence.id)
  expect(ended.occurrence.deliveries.map((delivery) => [delivery.type, delivery.status]).sort()).toEqual([['notify', 'delivered'], ['send_to_session', 'failed']])

  const [signal] = await signals.list(TEST_HANDLER_CTX, APP.id)
  expect(signal).toMatchObject({ name: 'report.ready', count7d: 1, count24h: 1, emittedBy: { kind: 'operation', name: 'save' } })
  expect(signal?.actions.map((action) => [action.action.type, action.delivered7d, action.failed7d]).sort()).toEqual([['notify', 1, 0], ['send_to_session', 0, 1]])
})
