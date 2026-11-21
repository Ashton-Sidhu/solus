import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { FileArtifact, SessionArtifacts } from '@solus/contracts/session-artifacts'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { SessionArtifactsStore } = await import('@solus/workspace-ui/contexts/sessions/session-artifacts.store.svelte')
type SessionArtifactsChange = import('@solus/workspace-ui/contexts/sessions/session-artifacts.store.svelte').SessionArtifactsChange

/**
 * The client list of what a session produced or linked
 * (docs/plans/session-artifacts.md), which the Threads row and the pull
 * request watch toggle read: a read from the host that runs the session, kept
 * on an equal answer, retried after a failure, and never written over by an
 * older read.
 */

const file = (path: string, linkedAt: number): FileArtifact => ({ kind: 'file', hostId: 'host-a', path, title: path, linkedAt })
const listOf = (...own: FileArtifact[]): SessionArtifacts => ({ own, children: [] })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => connections.reset())

describe('session artifacts store', () => {
  test('an equal answer keeps the list it holds, and only a real change is heard', async () => {
    let answer = listOf(file('a.md', 1))
    connections.registerHost('host-a', { sessionArtifactsList: async () => answer })
    const store = new SessionArtifactsStore()
    const heard: SessionArtifactsChange[] = []
    store.onChange((change) => heard.push(change))
    store.ensure('host-a', 's1')
    await flush()
    const first = store.artifactsFor('s1')

    // WHY: a read again after an event must not draw each row again when nothing changed.
    answer = listOf(file('a.md', 1))
    connections.emit('host-a', 'session.artifactsChanged', { sessionId: 's1' })
    await flush()
    expect(store.artifactsFor('s1')).toBe(first)

    answer = listOf(file('a.md', 1), file('b.md', 2))
    connections.emit('host-a', 'session.artifactsChanged', { sessionId: 's1' })
    await flush()
    expect(store.countFor('s1')).toBe(2)
    expect(heard.map((change) => [change.previousCount, change.count])).toEqual([[null, 1], [1, 2]])
    expect(store.lastChangeFor('s1')?.count).toBe(2)
  })

  test('a read that a newer read overtook does not write over the newer answer', async () => {
    const answers: Array<(list: SessionArtifacts) => void> = []
    connections.registerHost('host-a', {
      sessionArtifactsList: () => new Promise<SessionArtifacts>((resolve) => { answers.push(resolve) }),
    })
    const store = new SessionArtifactsStore()
    store.ensure('host-a', 's1')
    store.reload('s1')
    answers[1]?.(listOf(file('new.md', 2)))
    answers[0]?.(listOf(file('old.md', 1)))
    await flush()
    expect(store.artifactsFor('s1')?.own.map((item) => item.kind === 'file' && item.path)).toEqual(['new.md'])
  })

  test('a failed read is shown as failed, and a retry clears it', async () => {
    let fails = true
    connections.registerHost('host-a', {
      sessionArtifactsList: async () => {
        if (fails) throw new Error('offline')
        return listOf(file('a.md', 1))
      },
    })
    const store = new SessionArtifactsStore()
    store.ensure('host-a', 's1')
    await flush()
    expect(store.hasFailed('s1')).toBe(true)
    expect(store.isLoaded('s1')).toBe(false)

    fails = false
    store.reload('s1')
    await flush()
    expect(store.hasFailed('s1')).toBe(false)
    expect(store.countFor('s1')).toBe(1)
  })

  test('a pull request watch goes to the host that runs the session, and fails for a session not shown here', async () => {
    const watches: string[] = []
    connections.registerHost('host-a', { sessionArtifactsList: async () => listOf() })
    connections.registerHost('host-b', {
      sessionArtifactsList: async () => listOf(),
      sessionPullRequestWatch: async (sessionId: string, repository: string, number: number) => {
        watches.push(`host-b:${sessionId}:${repository}#${number}`)
        return 'started' as const
      },
    })
    const store = new SessionArtifactsStore()
    store.ensure('host-a', 's1')
    // The session moved to another host.
    store.ensure('host-b', 's1')
    await store.setPullRequestWatch({ sessionId: 's1', repository: 'acme/app', number: 7 }, true)
    expect(watches).toEqual(['host-b:s1:acme/app#7'])
    await expect(store.setPullRequestWatch({ sessionId: 's9', repository: 'acme/app', number: 7 }, true)).rejects.toThrow('This session is not shown here.')
  })
})
