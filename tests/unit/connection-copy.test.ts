import { describe, expect, test } from 'bun:test'
import { connectionSectionDescription } from '../../packages/workspace-ui/src/components/seats/lib/connection-copy'
import { cloudConnectionsPointerUrl } from '../../packages/workspace-ui/src/components/seats/lib/cloud-connections'
import type { HostIdentity } from '../../packages/workspace-ui/src/contexts/sharing/shares.store.svelte'

// docs/plans/cloud-service-model.md: a person connects GitHub, Google, and Atlassian
// once, in Solus cloud; every runner of the organization uses them for that person's
// turns. A runner linked to an organization points a member there, so they never
// overwrite the host's own connections.

const directoryUrl = 'https://app.solus.sh/'
const member: HostIdentity = { principal: 'org-member', userId: 'u1', organizationId: 'org 1' }

describe('the provider sections on a cloud row', () => {
  test('say the connection is the person’s own and every runner uses it', () => {
    for (const provider of ['github', 'google', 'atlassian'] as const) {
      const line = connectionSectionDescription(provider, true)
      expect(line).toMatch(/your own/i)
      expect(line).toMatch(/every runner uses it/i)
    }
    expect(connectionSectionDescription('github', true)).toContain('GitHub')
    expect(connectionSectionDescription('google', true)).toContain('Google')
    expect(connectionSectionDescription('atlassian', true)).toContain('Atlassian')
  })

  test('stay silent on a machine host, as before', () => {
    expect(connectionSectionDescription('github', false)).toBeUndefined()
  })
})

describe('where a host row keeps a person’s connections', () => {
  test('a cloud row shows the sections itself, whoever the person is', () => {
    expect(cloudConnectionsPointerUrl({ isCloudHost: true, identity: member, directoryUrl })).toBeNull()
  })

  test('a runner linked to an organization points a member at the cloud page', () => {
    // WHY: the member's connection must not overwrite the host's own; the row
    // links to the page shell route the client bundle parses.
    expect(cloudConnectionsPointerUrl({ isCloudHost: false, identity: member, directoryUrl }))
      .toBe('https://app.solus.sh/app/#/w/org%201/connections')
  })

  test('the owner, a guest, and a signed-out client keep the host’s sections', () => {
    for (const principal of ['local-owner', 'remote-owner', 'guest'] as const) {
      const identity: HostIdentity = { principal, userId: null, organizationId: 'org 1' }
      expect(cloudConnectionsPointerUrl({ isCloudHost: false, identity, directoryUrl })).toBeNull()
    }
    expect(cloudConnectionsPointerUrl({ isCloudHost: false, identity: undefined, directoryUrl })).toBeNull()
  })

  test('a member with no organization or no account origin has no page to open', () => {
    expect(cloudConnectionsPointerUrl({ isCloudHost: false, identity: { ...member, organizationId: null }, directoryUrl })).toBeNull()
    expect(cloudConnectionsPointerUrl({ isCloudHost: false, identity: member, directoryUrl: undefined })).toBeNull()
  })
})
