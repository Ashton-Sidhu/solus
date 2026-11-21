import { describe, expect, mock, spyOn, test } from 'bun:test'
import { serverConnections } from '@solus/client-core/server-connections'

// A tab whose machine was removed is read only. Its rows come from the
// session's copy in Solus Cloud, which the conversation reads as it does for
// any session with no host online (`CloudTranscriptStore`). The restore reads none.
const machineReferences = await import('@solus/workspace-ui/contexts/workspace/machine-references')
let hostsAreAuthoritative = true
mock.module('@solus/workspace-ui/contexts/workspace/machine-references', () => ({
  ...machineReferences,
  knownHostsAreAuthoritative: () => hostsAreAuthoritative,
}))

const { hydrateTabOnGoneMachine } = await import('@solus/workspace-ui/contexts/workspace/session-bootstrap')
const { makeSession } = await import('@solus/workspace-ui/contexts/workspace/session.factories')
const { GONE_MACHINE_READ_ONLY_REASON, LOCAL_HOST_OFF_READ_ONLY_REASON } = machineReferences

/** A restored tab that is on screen: its history shows as loading until a read ends. */
function restoredSession(organizationId: string | null) {
  return makeSession({ rateLimitBehavior: 'ask' } as never, {
    id: 'session', agentSessionId: 'provider-session', organizationId, run: { serverId: 'removed-vm' }, loadingHistory: true,
  })
}

describe('a restored tab on a removed machine', () => {
  test('is read only and asks no host or service for rows', () => {
    // WHY: the mirror is the one source of rows with no host online, and the
    // conversation reads it. A second read here, from the record home, gave an
    // organization session two paths and a personal session none.
    hostsAreAuthoritative = true
    const asked = spyOn(serverConnections, 'apiFor')
    for (const organizationId of ['org', 'local', null]) {
      const session = restoredSession(organizationId)

      expect(hydrateTabOnGoneMachine(session)).toBe(true)
      expect(session.readOnlyReason).toBe(GONE_MACHINE_READ_ONLY_REASON)
      expect(session.messages).toEqual([])
    }
    expect(asked).not.toHaveBeenCalled()
    asked.mockRestore()
  })

  test('ends the loading state, so the conversation reads the copy in Solus Cloud', () => {
    // WHY: the copy is read only when no host reads the history. No host read ends
    // here, so a restore that left the loading state on showed a skeleton with no end.
    hostsAreAuthoritative = true
    const session = restoredSession('org')

    hydrateTabOnGoneMachine(session)

    expect(session.loadingHistory).toBe(false)
  })

  test('stays pending until the saved hosts are authoritative', () => {
    // WHY: a host missing before the directory answers may still be listed;
    // the tab must not say its machine was removed yet.
    hostsAreAuthoritative = false
    const session = restoredSession('org')

    expect(hydrateTabOnGoneMachine(session)).toBe(false)
    expect(session.readOnlyReason).toBeNull()
  })

  test('a local host that is turned off says how to turn it on', () => {
    // WHY: a turned-off local host is not removed; its tab restores when it is back.
    hostsAreAuthoritative = false
    const off = spyOn(serverConnections, 'isLocalHostOff').mockReturnValue(true)
    const session = restoredSession(null)

    expect(hydrateTabOnGoneMachine(session)).toBe(true)
    expect(session.readOnlyReason).toBe(LOCAL_HOST_OFF_READ_ONLY_REASON)
    off.mockRestore()
  })
})
