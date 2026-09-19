import { describe, expect, test } from 'bun:test'
import { mergeSessionHomes, type SessionHomeHosts } from '@solus/workspace-ui/components/session/lib/session-home'

// docs/plans/cloud-service-model.md R1/R8: a session listed by both its runner and the
// organization's workspace service is one row. The runner is the row while it is
// connected; otherwise the cloud record stands in, marked "runner offline".

const CLOUD = 'workspace:org-1'

function hosts(connected: string[]): SessionHomeHosts {
  return {
    isCloudHost: (serverId) => serverId === CLOUD,
    isConnected: (serverId) => !!serverId && connected.includes(serverId),
  }
}

const row = (sessionId: string | null, serverId: string, label = sessionId ?? 'draft') => ({ sessionId, serverId, label })

describe('merging a session across its homes', () => {
  test('a session on a connected runner and on the cloud is one row, under the runner', () => {
    // WHY: the runner holds the transcript and can open it; the record would be a
    // second, weaker row for the same conversation.
    const merged = mergeSessionHomes([row('s1', CLOUD), row('s1', 'mac'), row('s2', 'mac')], hosts(['mac']))
    expect(merged).toEqual([row('s1', 'mac'), row('s2', 'mac')])
    expect(merged[0].runnerOffline).toBeUndefined()
  })

  test('with the runner offline the cloud record stands in, marked', () => {
    const merged = mergeSessionHomes([row('s1', 'mac'), row('s1', CLOUD)], hosts([]))
    expect(merged).toEqual([{ ...row('s1', CLOUD), runnerOffline: true }])
  })

  test('a record the runner never listed is marked too: its transcript is not reachable', () => {
    expect(mergeSessionHomes([row('s9', CLOUD)], hosts(['mac']))).toEqual([{ ...row('s9', CLOUD), runnerOffline: true }])
  })

  test('two runners: the connected one wins; none connected keeps the first as before', () => {
    expect(mergeSessionHomes([row('s1', 'mac'), row('s1', 'linux')], hosts(['linux']))).toEqual([row('s1', 'linux')])
    expect(mergeSessionHomes([row('s1', 'mac'), row('s1', 'linux')], hosts([]))).toEqual([row('s1', 'mac')])
  })

  test('rows without a session id pass through in place, and order follows first appearance', () => {
    const draft = row(null, 'mac')
    const merged = mergeSessionHomes([row('s2', CLOUD), draft, row('s1', 'mac'), row('s2', 'mac')], hosts(['mac']))
    expect(merged.map((item) => item.sessionId)).toEqual(['s2', null, 's1'])
    expect(merged[0].serverId).toBe('mac')
    expect(merged[1]).toBe(draft)
  })
})
