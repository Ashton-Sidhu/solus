import { expect, test } from 'bun:test'
import { flushRpcContinuations, sessionOpenRpcFixture } from '../../scripts/lib/session-open-rpc-fixture'

test('restored status reads batch per host without mixing session ids', async () => {
  const fixture = sessionOpenRpcFixture(20)
  fixture.startMetadata()
  await flushRpcContinuations()
  expect(fixture.reads.map((read) => read.method)).toEqual(['getSessionInfos', 'getSessionInfos'])
  expect(fixture.reads[0].keys).toEqual(Array.from({ length: 10 }, (_, index) => `provider-${index * 2}`))
  expect(fixture.reads[1].keys).toEqual(Array.from({ length: 10 }, (_, index) => `provider-${index * 2 + 1}`))
  for (const read of fixture.reads) read.resolve()
  await flushRpcContinuations()
})

test('history starts beside lineage, but live events attach only after history is applied', async () => {
  const fixture = sessionOpenRpcFixture(1, { deferToolInputs: true })
  const opening = fixture.open()
  expect(fixture.reads.map((read) => read.method)).toEqual(['loadSession', 'resolveSessionLineage'])
  expect(fixture.historyRequests).toEqual([{ sessionId: 'provider-0', limit: 200, deferToolInputs: true }])
  fixture.reads[1].resolve()
  await flushRpcContinuations()
  expect(fixture.reads).toHaveLength(2)
  expect(fixture.session.messages).toHaveLength(0)
  fixture.reads[0].resolve()
  await flushRpcContinuations()
  expect(fixture.session.messages[0]?.content).toBe('Ready')
  expect(fixture.session.loadingHistory).toBe(false)
  expect(fixture.reads[2].method).toBe('watchSession')
  fixture.reads[2].resolve()
  expect(await opening).toBe(true)
})

test('early history uses the saved provider id but conversion uses resolved stable identity', async () => {
  const member = { position: 0, provider: 'codex' as const, providerSessionId: 'provider-0', cwd: '/fixture', startedAt: 1, endedAt: null }
  const fixture = sessionOpenRpcFixture(1, { lineage: { sessionId: 'stable-session', active: member, members: [member], lineageToken: '1' } })
  const opening = fixture.open()
  fixture.reads[0].resolve()
  await flushRpcContinuations()
  expect(fixture.session.messages).toHaveLength(0)
  fixture.reads[1].resolve()
  await flushRpcContinuations()
  expect(fixture.transcriptIdentities).toEqual(['stable-session'])
  expect(fixture.historyRequests).toHaveLength(1)
  fixture.reads[2].resolve()
  await opening
})

test('an early history failure is observed and still rejects hydration for retry', async () => {
  const fixture = sessionOpenRpcFixture()
  const opening = fixture.open()
  fixture.reads[0].reject(new Error('offline'))
  await flushRpcContinuations()
  const outcome = opening.catch((error: Error) => error)
  fixture.reads[1].resolve()
  expect(await outcome).toMatchObject({ message: 'offline' })
  expect(fixture.session.loadingHistory).toBe(false)
  expect(fixture.reads).toHaveLength(2)
})

test('closing a tab while lineage is pending cannot attach its runtime', async () => {
  const fixture = sessionOpenRpcFixture()
  const opening = fixture.open()
  fixture.close()
  for (const read of fixture.reads) read.resolve()
  expect(await opening).toBe(false)
  expect(fixture.reads).toHaveLength(2)
})
