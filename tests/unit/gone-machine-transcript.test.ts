import { describe, expect, mock, spyOn, test } from 'bun:test'
import type { Message, SessionMeta } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'

// A tab whose machine was removed reads the transcript its organization's
// workspace service mirrored. These stand in for that service.
const pageReads: string[] = []
mock.module('@solus/workspace-ui/contexts/sessions/session-record-transcript', () => ({
  readSessionRecordPage: async (_workspace: unknown, serverId: string) => {
    pageReads.push(serverId)
    return { messages: [message('newest')], before: 'older-cursor', pendingMessages: [] }
  },
}))
const machineReferences = await import('@solus/workspace-ui/contexts/workspace/machine-references')
mock.module('@solus/workspace-ui/contexts/workspace/machine-references', () => ({
  ...machineReferences,
  savedHostsAreAuthoritative: () => true,
}))

const { hydrateTabOnGoneMachine } = await import('@solus/workspace-ui/contexts/workspace/session-bootstrap')
const { makeSession } = await import('@solus/workspace-ui/contexts/workspace/session.factories')
const { GONE_MACHINE_NO_RECORD_REASON, GONE_MACHINE_READ_ONLY_REASON } = machineReferences

function message(id: string): Message {
  return { id, role: 'user', content: id, timestamp: 1 } as Message
}

function meta(): SessionMeta {
  return { provider: 'claude-code', sessionId: 'session', slug: null, firstMessage: null, lastTimestamp: '', size: 0, cwd: '/repo', projectPath: '/repo' }
}

/** The record each workspace service answers with, by service id. */
function servicesHolding(records: Record<string, SessionMeta | null>) {
  const asked: string[] = []
  spyOn(serverConnections, 'apiFor').mockImplementation(((serverId: string) => ({
    getSessionInfo: async () => {
      asked.push(serverId)
      return records[serverId] ?? null
    },
  })) as never)
  return asked
}

function restoredTab(organizationId: string | null) {
  const session = makeSession({ rateLimitBehavior: 'ask' } as never, { id: 'session', agentSessionId: 'provider-session', organizationId, run: { serverId: 'removed-vm' } })
  const ctx = { sessionFor: () => session, eventReducer: { rebuildAgentConversations: () => {} } }
  return { session, ctx: ctx as never, snapTab: { tabId: 'tab' } as never }
}

describe('a restored tab on a removed machine', () => {
  test('reads the transcript from its organization\'s workspace service', async () => {
    // WHY: the machine's own copy went with it. The organization's workspace
    // service mirrored the transcript, so that is where the tab reads it — not
    // the window's default host, which never held another machine's work.
    pageReads.length = 0
    const asked = servicesHolding({ 'workspace:org': meta() })
    const { session, ctx, snapTab } = restoredTab('org')

    expect(await hydrateTabOnGoneMachine(ctx, snapTab, session)).toBe(true)

    expect(asked).toEqual(['workspace:org'])
    expect(pageReads).toEqual(['workspace:org'])
    expect(session.messages.map((m) => m.id)).toEqual(['newest'])
    expect(session.historyCursor).toBe('older-cursor')
    expect(session.historyTruncated).toBe(true)
    expect(session.readOnlyReason).toBe(GONE_MACHINE_READ_ONLY_REASON)
    expect(session.loadingHistory).toBe(false)
  })

  test('a personal session says no copy exists without asking anyone', async () => {
    // WHY: a personal session's record lived on its machine only.
    const asked = servicesHolding({})
    for (const organizationId of ['local', null]) {
      const { session, ctx, snapTab } = restoredTab(organizationId)

      expect(await hydrateTabOnGoneMachine(ctx, snapTab, session)).toBe(true)
      expect(session.readOnlyReason).toBe(GONE_MACHINE_NO_RECORD_REASON)
    }
    expect(asked).toEqual([])
  })

  test('says no copy exists when the workspace service has none', async () => {
    // WHY: an empty read-only tab with no reason reads as a loading failure.
    servicesHolding({})
    const { session, ctx, snapTab } = restoredTab('org')

    expect(await hydrateTabOnGoneMachine(ctx, snapTab, session)).toBe(true)
    expect(session.readOnlyReason).toBe(GONE_MACHINE_NO_RECORD_REASON)
  })

  test('stays pending when the workspace service cannot be read', async () => {
    // WHY: an unreachable service is not an answer; selection or reconnect retries.
    spyOn(serverConnections, 'apiFor').mockImplementation((() => ({
      getSessionInfo: async () => { throw new Error('offline') },
    })) as never)
    const { session, ctx, snapTab } = restoredTab('org')

    expect(await hydrateTabOnGoneMachine(ctx, snapTab, session)).toBe(false)
    expect(session.readOnlyReason).toBe(GONE_MACHINE_READ_ONLY_REASON)
  })
})
