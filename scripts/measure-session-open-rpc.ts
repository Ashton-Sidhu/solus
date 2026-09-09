import { flushRpcContinuations, sessionOpenRpcFixture } from './lib/session-open-rpc-fixture'

const metadata = sessionOpenRpcFixture(20)
metadata.startMetadata()
await flushRpcContinuations()
const metadataReads = metadata.reads.map(({ method, keys }) => ({ method, sessions: keys.length }))
for (const read of metadata.reads) read.resolve()
await flushRpcContinuations()

const fixture = sessionOpenRpcFixture()
const opening = fixture.open()
const stages: string[][] = []
let released = 0
let transcriptStage = 0
for (let stage = 1; stage <= 10; stage++) {
  await flushRpcContinuations()
  const pending = fixture.reads.slice(released)
  if (!pending.length) break
  stages.push(pending.map((read) => read.method))
  released += pending.length
  for (const read of pending) read.resolve()
  await flushRpcContinuations()
  if (!transcriptStage && fixture.session.messages.length) transcriptStage = stage
}
await opening
console.log(JSON.stringify({
  restoredTabs: 20, hosts: 2, metadataRpcCount: metadataReads.length, metadataReads,
  openingRpcStages: stages, transcriptRoundTrips: transcriptStage,
  note: 'Production command scheduling with gated mock RPCs; round trips, not wall-clock latency.',
}, null, 2))
