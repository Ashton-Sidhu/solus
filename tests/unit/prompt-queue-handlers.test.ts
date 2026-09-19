import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { HostApi } from '@solus/contracts/host-api'
import type { HostEventName } from '@solus/contracts/host-events'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §4: a prompt waits only on the workspace
// service. A host that runs the session itself prompts it live, so enqueueing
// there is refused; listing and withdrawing answer from the queue anywhere.

type Principal = import('@solus/server/server/principal').Principal
type HandlerCtx = import('@solus/server/server/server').HandlerCtx
type Handler = (args: unknown[], ctx: HandlerCtx) => Promise<unknown>

let handlers: typeof import('@solus/server/server/handlers/prompt-queue-handlers')
let queue: typeof import('@solus/server/sessions/prompt-queue')
let dbModule: typeof import('@solus/server/db')
const previousDataDir = process.env.SOLUS_DATA_DIR
const previousWorkspace = process.env.SOLUS_WORKSPACE
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-prompt-queue-handlers-'))
  process.env.SOLUS_DATA_DIR = dataDir
  delete process.env.SOLUS_WORKSPACE
  handlers = await import('@solus/server/server/handlers/prompt-queue-handlers')
  queue = await import('@solus/server/sessions/prompt-queue')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousWorkspace !== undefined) process.env.SOLUS_WORKSPACE = previousWorkspace
})

const member = (userId: string, organizationRole: 'owner' | 'member' = 'member'): Principal => ({
  kind: 'org-member', userId, organizationId: 'org1', organizationRole, teamIds: [], hostKind: 'managed', displayName: userId, deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud',
})
const ctx = (principal: Principal): HandlerCtx => ({ clientId: 'ws:1', principal })

function registered(): { call: <K extends keyof HostApi>(method: K, args: Parameters<HostApi[K]>, principal: Principal) => Promise<unknown>; events: Array<{ type: HostEventName; payload: unknown }> } {
  const table = new Map<string, Handler>()
  const events: Array<{ type: HostEventName; payload: unknown }> = []
  const server = { register: (method: string, handler: Handler) => { table.set(method, handler) } }
  const publisher = { broadcast: async (type: HostEventName, payload: unknown) => { events.push({ type, payload }); return 0 } }
  handlers.registerPromptQueueHandlers(
    server as unknown as Parameters<typeof handlers.registerPromptQueueHandlers>[0],
    { events: publisher as unknown as Parameters<typeof handlers.registerPromptQueueHandlers>[1]['events'] },
  )
  return {
    events,
    call: (method, args, principal) => {
      const handler = table.get(method)
      if (!handler) throw new Error(`no handler for ${method}`)
      return handler(args, ctx(principal))
    },
  }
}

describe('prompt queue handlers', () => {
  test('a host outside workspace mode refuses to queue: it runs the session itself', async () => {
    const { call, events } = registered()
    await expect(call('sessionPromptEnqueue', [{ sessionId: 's1', text: 'go' }], member('alice'))).rejects.toThrow(/wait only on the cloud workspace/)
    expect(events).toEqual([])
    expect(await queue.listQueue('local', 's1')).toEqual([])
  })

  test('withdrawing is the author\'s or an administrator\'s, and tells the session\'s watchers', async () => {
    const { call, events } = registered()
    const mine = await queue.enqueuePrompt('local', { sessionId: 's1', authorUserId: 'alice', authorDisplayName: 'Alice', text: 'one' })
    const theirs = await queue.enqueuePrompt('local', { sessionId: 's1', authorUserId: 'bob', authorDisplayName: 'Bob', text: 'two' })
    expect(await call('sessionPromptQueueList', ['s1'], member('carol'))).toHaveLength(2)

    await expect(call('sessionPromptQueueCancel', [{ queueId: theirs.queueId }], member('alice'))).rejects.toThrow(/author or a host administrator/)
    expect(await call('sessionPromptQueueCancel', [{ queueId: mine.queueId }], member('alice'))).toEqual({ cancelled: true })
    // An organization owner administers a managed host.
    expect(await call('sessionPromptQueueCancel', [{ queueId: theirs.queueId }], member('carol', 'owner'))).toEqual({ cancelled: true })
    expect(await call('sessionPromptQueueCancel', [{ queueId: theirs.queueId }], member('carol', 'owner'))).toEqual({ cancelled: false })
    expect(events).toEqual([
      { type: 'session.promptQueueChanged', payload: { sessionId: 's1' } },
      { type: 'session.promptQueueChanged', payload: { sessionId: 's1' } },
    ])
  })
})
