import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostRegistration } from '@solus/contracts/uplink'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * A turn the previous process never settled is marked `interrupted` at boot.
 * The Solus API must hear it too: else the organization sees the session
 * `running` until its next turn. The sweep is one update with no change event;
 * at boot the delivery sends every own organization session's record once
 * (simplify-auth-and-sync §5), the interrupted ones among them.
 */

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-runner-interrupt-'))
  process.env.SOLUS_DATA_DIR = dataDir
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const link: HostRegistration = { hostId: 'runner-host', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', generation: 1, apiUrl: 'https://api.test' }

test('at boot every own published organization session is queued once, the one the sweep settled as interrupted', async () => {
  const records = await import('@solus/server/data/sessions/session-records')
  const queue = await import('@solus/server/sync/delivery-queue')
  const { RunnerDelivery } = await import('@solus/server/sync/runner-delivery')

  // The previous process: an organization session, published, mid-turn when it ended.
  records.rememberSessionBirth('solus-killed', { organizationId: 'org_a', published: true, ownerKey: 'bob', admissionId: 'solus-killed' })
  await records.upsertOwnSessionRecord({ sessionId: 'solus-killed', provider: 'codex', projectPath: '-repo', status: 'running', lastActivityAt: Date.now() })
  // A Local session left running is this machine's own: it is settled here and reported nowhere.
  await records.upsertOwnSessionRecord({ sessionId: 'solus-local', provider: 'codex', projectPath: '-repo', status: 'running', lastActivityAt: Date.now() })

  // Boot: the sweep runs before the delivery follows record changes; the delivery is not started.
  const swept = await records.markOwnRunningSessionRecordsInterrupted()
  expect(swept.sort()).toEqual(['solus-killed', 'solus-local'])
  const delivery = new RunnerDelivery({ registration: () => link, delegations: { accessToken: async () => 'unused' }, owner: () => 'alice' })
  await delivery.reportStoredSessions(await records.ownPublishedSessionIds())

  const queued = queue.listDelivery({ organizationId: 'org_a', actorUserId: 'bob' }, 10)
  expect(queued.map((item) => item.payload)).toEqual([expect.objectContaining({ sessionId: 'solus-killed', status: 'interrupted', runnerHostId: 'runner-host', admissionId: 'solus-killed' })])
  expect(queue.listDelivery({ organizationId: 'local', actorUserId: '' }, 10)).toEqual([])
})
