import { describe, expect, test } from 'bun:test'
import type { ResourceRole } from '@solus/contracts/sharing'
import type { Principal } from '@solus/server/admission/principal'
import type { ResolvedLinkShare } from '@solus/server/sharing/share-manager'
import { ShareLinkResolver } from '@solus/server/sharing/share-link-resolver'

// docs/plans/instant-share-open.md: one request answers what a link opens and whom it
// opens it as, so the page boots once. A member whose own role is at least the link's
// opens it as themselves; anyone else is a guest with the link's role, so a link never
// gives a member less than a stranger.

const SECRET = 's'.repeat(32)
const LINK: ResolvedLinkShare = { organizationId: 'org1', resource: { kind: 'session', id: 'sess1' }, role: 'editor', sharedByUserId: 'alice', linkSecretHash: 'h' }
const BOB: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'cloud', displayName: 'Bob', deviceId: 'g1', expiresAt: 0, deviceLabel: 'Solus cloud' }

function resolver(options: { link?: ResolvedLinkShare | null; role?: ResourceRole; runner?: string | null } = {}) {
  const asked: string[] = []
  const link = options.link === undefined ? LINK : options.link
  const shareLinks = new ShareLinkResolver({
    shares: {
      openLink: async (secret) => (secret === SECRET && link
        ? { share: link, runnerHostId: options.runner === undefined ? 'host-a' : options.runner, roleOf: () => options.role ?? 'none' }
        : null),
    },
    hostRoutes: async (hostId) => [{ kind: 'tunnel', url: `https://h-${hostId}.example` }],
  })
  const memberIn = (principal: Principal | null) => async (organizationId: string) => {
    asked.push(organizationId)
    return principal
  }
  return { shareLinks, asked, memberIn }
}

describe('a share link resolves in one request', () => {
  test('a member with at least the link role opens it as themselves, with their own role', async () => {
    const { shareLinks, asked, memberIn } = resolver({ role: 'owner' })
    const target = await shareLinks.resolve(SECRET, memberIn(BOB))
    expect(target?.opensAs).toEqual({ kind: 'member', role: 'owner' })
    // The membership asked about is the resource's organization, never one the page names.
    expect(asked).toEqual(['org1'])
  })

  test('a member with less than the link role opens it as a guest with the link role', async () => {
    const { shareLinks, memberIn } = resolver({ role: 'viewer' })
    expect((await shareLinks.resolve(SECRET, memberIn(BOB)))?.opensAs).toEqual({ kind: 'guest', role: 'editor' })
  })

  test('a visitor with no membership there is a guest', async () => {
    const { shareLinks, memberIn } = resolver({ role: 'owner' })
    expect((await shareLinks.resolve(SECRET, memberIn(null)))?.opensAs).toEqual({ kind: 'guest', role: 'editor' })
  })

  test('the answer names the host that runs the session, with its routes', async () => {
    const { shareLinks, memberIn } = resolver()
    expect((await shareLinks.resolve(SECRET, memberIn(null)))?.host).toEqual({ hostId: 'host-a', routes: [{ kind: 'tunnel', url: 'https://h-host-a.example' }] })
  })

  test('a work and a session nobody runs name no host', async () => {
    const work = resolver({ link: { ...LINK, resource: { kind: 'work', id: 'w1' } }, runner: null })
    expect((await work.shareLinks.resolve(SECRET, work.memberIn(null)))?.host).toBeNull()
    const idle = resolver({ runner: null })
    expect((await idle.shareLinks.resolve(SECRET, idle.memberIn(null)))?.host).toBeNull()
  })

  test('an unknown secret opens nothing and asks about no membership', async () => {
    const { shareLinks, asked, memberIn } = resolver()
    expect(await shareLinks.resolve('x'.repeat(32), memberIn(BOB))).toBeNull()
    expect(asked).toEqual([])
  })
})
