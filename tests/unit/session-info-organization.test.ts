import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SessionMeta } from '@solus/contracts/types'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import type { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/workspace-and-machines.md §6: a host names the organization of a
// session's record when it describes the session, so a client can still find
// the record once this machine is removed.

type Principal = import('@solus/server/admission/principal').Principal

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let records: typeof import('@solus/server/data/sessions/session-records')
let serverModule: typeof import('@solus/server/transport/server')
let historyHandlers: typeof import('@solus/server/transport/handlers/history-handlers')
let dbModule: typeof import('@solus/server/db')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-info-organization-'))
  process.env.SOLUS_DATA_DIR = dataDir
  records = await import('@solus/server/data/sessions/session-records')
  serverModule = await import('@solus/server/transport/server')
  historyHandlers = await import('@solus/server/transport/handlers/history-handlers')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const LOCAL_OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }

function providerMeta(sessionId: string): SessionMeta {
  return { provider: 'claude-code', sessionId, slug: null, firstMessage: 'Hi', lastTimestamp: '', size: 1, cwd: '/repo', projectPath: '-repo' }
}

test('a host names the organization of a session\'s record beside its provider metadata', async () => {
  await records.upsertOwnSessionRecord({ sessionId: 'org-session', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
  await records.assignSessionOrganization('org-session', 'org1')
  const server = new serverModule.SolusServer()
  historyHandlers.registerHistoryHandlers(server, {
    // SAFETY: the metadata reads under test touch only the provider history reader; the publisher is never called.
    sessionRuntime: { history: {
      getSessionInfo: async (sessionId: string) => providerMeta(sessionId),
      describeSession: async (sessionId: string) => ({ lineage: null, meta: providerMeta(sessionId) }),
    } } as never as SessionRuntime,
    events: {} as HostEventPublisher,
    agentIdFromContext: () => 'claude-code',
    exchangeProgress: () => undefined,
  })
  const ctx = { clientId: 'ipc:owner', principal: LOCAL_OWNER }

  const [recorded, unrecorded] = await server.handle('getSessionInfos', [['org-session', 'no-record']], ctx)
  const described = await server.handle('describeSession', ['org-session'], ctx)

  expect(recorded).toMatchObject({ firstMessage: 'Hi', organizationId: 'org1' })
  expect(described.meta?.organizationId).toBe('org1')
  // A session the host keeps no record of names no organization.
  expect(unrecorded?.organizationId).toBeUndefined()
})
