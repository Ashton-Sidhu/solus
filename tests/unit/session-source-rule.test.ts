import { describe, expect, test } from 'bun:test'
import { solusApiId } from '@solus/contracts/uplink'
import { answersForOwnSessions, readsSessionsFromSolusApi, sessionHomeId, type SessionHomeConnections } from '@solus/client-core/session-home'

// docs/session-cloud-copy.md: the setting "Save sessions to Solus Cloud" is the
// first question of where a session is read from, and the kind of its machine is
// the second. With the setting off, no conversation is in Solus Cloud, so the
// machine is the one source and the Solus API must not answer for the session.

const api = solusApiId('acme')
const published = { organizationId: 'acme', publication: 'published' as const }

function connections(options: { saves?: boolean; apiConnected?: boolean } = {}): SessionHomeConnections {
  return {
    serverIds: () => ['laptop', 'vm', ...(options.apiConnected === false ? [] : [api])],
    isCloudHost: (serverId) => serverId === 'vm',
    ...(options.saves === undefined ? {} : { savesSessionsToCloud: () => options.saves! }),
  }
}

describe('where a session is read from', () => {
  test('an organization that saves its sessions: the Solus API answers for a cloud machine, a personal machine answers for itself', () => {
    for (const hosts of [connections(), connections({ saves: true })]) {
      expect(readsSessionsFromSolusApi('acme', hosts)).toBe(true)
      expect(sessionHomeId('vm', published, hosts)).toBe(api)
      expect(sessionHomeId('laptop', published, hosts)).toBe('laptop')
      expect(answersForOwnSessions({ serverId: 'vm', organizationId: 'acme' }, hosts)).toBe(false)
      expect(answersForOwnSessions({ serverId: 'laptop', organizationId: null }, hosts)).toBe(true)
    }
  })

  test('an organization that keeps its sessions on their hosts: each machine answers for its own, a cloud machine included', () => {
    // WHY: the Solus API has no conversation of these sessions. If it stayed their
    // source, a session would open on a copy that does not exist.
    const hosts = connections({ saves: false })
    expect(readsSessionsFromSolusApi('acme', hosts)).toBe(false)
    expect(sessionHomeId('vm', published, hosts)).toBe('vm')
    expect(sessionHomeId('laptop', published, hosts)).toBe('laptop')
    expect(answersForOwnSessions({ serverId: 'vm', organizationId: 'acme' }, hosts)).toBe(true)
  })

  test('a cloud machine answers for its own sessions while this client has no connection to the Solus API', () => {
    const hosts = connections({ saves: true, apiConnected: false })
    expect(sessionHomeId('vm', published, hosts)).toBe('vm')
    expect(answersForOwnSessions({ serverId: 'vm', organizationId: 'acme' }, hosts)).toBe(true)
  })

  test('a session that is not published, or is of no organization, stays with its machine', () => {
    const hosts = connections({ saves: true })
    expect(sessionHomeId('vm', { organizationId: 'acme', publication: 'local' }, hosts)).toBe('vm')
    expect(sessionHomeId('vm', { organizationId: 'local' }, hosts)).toBe('vm')
  })
})
