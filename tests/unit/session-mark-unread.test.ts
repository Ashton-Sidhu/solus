import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { Session, Tab } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { SessionMetadata } from '@solus/workspace-ui/contexts/workspace/session-metadata.svelte'

type MetadataHarness = Pick<SessionMetadata, 'markSessionUnread' | 'applySessionReadState'> & {
  workspace: {
    tabs: Record<string, Tab>
    sessions: { byId: Record<string, Pick<Session, 'run'>> }
    tabIdsForSession: (sessionId: string) => string[]
  }
}

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore() })

function fixture() {
  // Supply only the fields read by the two metadata methods under test.
  const metadata = Object.create(SessionMetadata.prototype) as MetadataHarness
  metadata.workspace = {
    tabs: {
      lead: { id: 'lead', sessionId: 'lead-session', hasUnread: false },
      worker: { id: 'worker', sessionId: 'worker-session', hasUnread: false },
      duplicate: { id: 'duplicate', sessionId: 'worker-session', hasUnread: false },
    },
    sessions: { byId: { 'worker-session': { run: { serverId: 'worker-host' } } } },
    tabIdsForSession: (sessionId) => Object.values(metadata.workspace.tabs)
      .filter((tab) => tab.sessionId === sessionId).map((tab) => tab.id),
  }
  return metadata
}

describe('mark a session unread', () => {
  test('marks the selected worker and all its tabs without changing its lead', async () => {
    const metadata = fixture()
    const api = serverConnections.apiFor('worker-host')
    const write = spyOn(api, 'setSessionReadState').mockResolvedValue(null)
    const route = spyOn(serverConnections, 'apiFor').mockReturnValue(api)
    spies.push(write, route)

    await metadata.markSessionUnread('worker-host', 'worker-session')

    expect(route).toHaveBeenCalledWith('worker-host')
    expect(write).toHaveBeenCalledWith('worker-session', null)
    expect(metadata.workspace.tabs.worker.hasUnread).toBe(true)
    expect(metadata.workspace.tabs.duplicate.hasUnread).toBe(true)
    expect(metadata.workspace.tabs.lead.hasUnread).toBe(false)
    metadata.applySessionReadState('worker-session', 123)
    expect(metadata.workspace.tabs.worker.hasUnread).toBe(false)
    expect(metadata.workspace.tabs.duplicate.hasUnread).toBe(false)
  })

  test('a failed host write leaves the local session read and reports the failure', async () => {
    const metadata = fixture()
    const api = serverConnections.apiFor('worker-host')
    const write = spyOn(api, 'setSessionReadState').mockRejectedValue(new Error('Disconnected'))
    const route = spyOn(serverConnections, 'apiFor').mockReturnValue(api)
    spies.push(write, route)

    await expect(metadata.markSessionUnread('worker-host', 'worker-session')).rejects.toThrow('Disconnected')
    expect(metadata.workspace.tabs.worker.hasUnread).toBe(false)
  })

  test('a closed session can be marked unread without opening a tab', async () => {
    const metadata = fixture()
    const api = serverConnections.apiFor('closed-host')
    const write = spyOn(api, 'setSessionReadState').mockResolvedValue(null)
    const route = spyOn(serverConnections, 'apiFor').mockReturnValue(api)
    spies.push(write, route)

    await metadata.markSessionUnread('closed-host', 'closed-session')
    expect(write).toHaveBeenCalledWith('closed-session', null)
    expect(metadata.workspace.tabs.worker.hasUnread).toBe(false)
  })
})
