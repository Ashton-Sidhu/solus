import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { SessionDigest, SessionTree } from '@solus/contracts/session-digest'
import type { SessionRecord } from '@solus/contracts/types'
import type { RemoteHost } from '@solus/server/execution/orchestration/remote-hosts'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * The parent's host keeps a copy of a delegate that runs on another host, so
 * the parent's session tree is read from its own database, also while that
 * host is offline (docs/plans/session-digests.md decision 8).
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

let directory: string
const previous = process.env.SOLUS_DATA_DIR

function digestOf(reply: string): SessionDigest {
  return { sessionId: 'remote-child', turns: [], changes: null, subagents: [], lastReply: reply, updatedAt: 1 }
}

/** Host B as the copier sees it: its tree of the child, and the events it sends. */
function hostB(initial: string) {
  let reply = initial
  let failing = false
  const reads: string[] = []
  const readWaiters: Array<{ count: number; resolve: () => void }> = []
  const listeners = new Map<string, Set<(payload: { sessionId: string }) => void>>()
  const record = (sessionId: string): SessionRecord => ({
    sessionId, organizationId: 'local', publication: 'local', ownerKey: 'b-owner', provider: 'codex', projectPath: '/b/project',
    projectRemote: null, runnerHostId: null, title: 'Remote child', customTitle: null, status: 'idle', model: null, reasoningEffort: null,
    parentSessionId: null, rootSessionId: null, createdAt: 5, lastActivityAt: 6, size: 0, cwd: '/b/project', slug: null,
    isWorktree: false, branch: null, projectRoot: null, delegation: null, place: null, startedBy: null,
  })
  const host = {
    hostId: 'host-b',
    installationId: 'installation-b',
    label: 'Host B',
    api: {
      sessionTree: async (sessionId: string): Promise<SessionTree> => {
        reads.push(sessionId)
        for (const waiter of readWaiters.filter((candidate) => reads.length >= candidate.count)) waiter.resolve()
        if (failing) throw new Error('Host B is offline')
        return { nodes: [{ record: record(sessionId), digest: digestOf(reply), artifacts: [] }] }
      },
    },
    events: {
      subscribe: (topic: string, listener: (payload: { sessionId: string }) => void) => {
        const set = listeners.get(topic) ?? new Set()
        set.add(listener)
        listeners.set(topic, set)
        return () => set.delete(listener)
      },
    },
    onReconnected: () => () => {},
    call: <T>(_what: string, request: () => Promise<T>) => request(),
  }
  return {
    // SAFETY: the copier uses only the members above.
    host: host as unknown as RemoteHost,
    reads,
    /** Resolves once host B has been asked for its tree `count` times. */
    readsReach: (count: number) => new Promise<void>((resolve) => {
      if (reads.length >= count) resolve()
      else readWaiters.push({ count, resolve })
    }),
    say: (next: string) => { reply = next },
    fail: () => { failing = true },
    send: (topic: string, sessionId: string) => { for (const listener of listeners.get(topic) ?? []) listener({ sessionId }) },
  }
}

/** Resolves when the parent's tree next changes: the copy was stored. */
async function nextCopy(): Promise<void> {
  const { onSessionDigestChanged } = await import('@solus/server/data/sessions/session-digests')
  return new Promise((resolve) => {
    const stop = onSessionDigestChanged((sessionId) => {
      if (sessionId !== 'lead') return
      stop()
      resolve()
    })
  })
}

async function storedReply(): Promise<string | null | undefined> {
  const { readSessionTree } = await import('@solus/server/data/sessions/session-digests')
  return (await readSessionTree('local', 'lead')).nodes.find((node) => node.record.sessionId === 'remote-child')?.digest?.lastReply
}

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-remote-copies-')))
  process.env.SOLUS_DATA_DIR = directory
  const { getDatabase } = await import('@solus/server/db/database')
  await getDatabase().run(sql`
    INSERT INTO session_records(session_id, organization_id, created_by, provider, project_path, cwd, status, created_at, last_activity_at, started_at)
    VALUES ('lead', 'local', 'owner', 'claude-code', ${directory}, ${directory}, 'running', 1, 9, 1)
  `)
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(directory, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
})

describe('remote session copies', () => {
  test('a delegate on another host is copied under its parent at once, and again when that host announces a change', async () => {
    const { copyRemoteSessionTree } = await import('@solus/server/execution/orchestration/remote-session-copies')
    const b = hostB('Started.')
    let copied = nextCopy()
    const stop = copyRemoteSessionTree(b.host, 'remote-child', 'lead')
    await copied
    expect(await storedReply()).toBe('Started.')

    b.say('Done.')
    copied = nextCopy()
    b.send('session.digestChanged', 'remote-child')
    await copied
    expect(await storedReply()).toBe('Done.')

    // A change to another session of host B reads nothing.
    b.send('session.artifactsChanged', 'someone-else')
    expect(b.reads).toEqual(['remote-child', 'remote-child'])

    // When the exchange ends, one last read keeps what the session did by then.
    b.say('Final.')
    copied = nextCopy()
    stop()
    await copied
    expect(await storedReply()).toBe('Final.')
    b.send('session.digestChanged', 'remote-child')
    expect(b.reads).toHaveLength(3)
  })

  test('a host that cannot answer keeps the last copy', async () => {
    // WHY: the copy is what the parent's tree shows while the other host is offline.
    const { copyRemoteSessionTree } = await import('@solus/server/execution/orchestration/remote-session-copies')
    const b = hostB('Kept.')
    const copied = nextCopy()
    const stop = copyRemoteSessionTree(b.host, 'remote-child', 'lead')
    await copied
    b.fail()
    b.send('session.digestChanged', 'remote-child')
    stop()
    // The change and the stop came while the first read was still storing: they are one more read.
    // It throws before it can store anything, and the copier does not throw.
    await b.readsReach(2)
    expect(await storedReply()).toBe('Kept.')
  })
})
