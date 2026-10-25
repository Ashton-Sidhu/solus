import { describe, expect, test } from 'bun:test'
import type { ShareLinkTarget } from '@solus/contracts/sharing'
import { solusApiId } from '@solus/contracts/uplink'
import { appLinkUrl } from '@solus/workspace-ui/contexts/sharing/app-link'
import { shareLinkOpening } from '../../apps/client/src/lib/share-link-opening'

// docs/plans/instant-share-open.md: the page boots once, as the resolve answers. A
// member goes straight to the resource in the whole app, on its organization's
// workspace service, with the host that runs it named so it is dialed first; a guest
// dials that host and reads the API's copy when it does not answer.

const ORIGIN = 'https://app.solus.sh'
const LINK = { resource: { kind: 'session' as const, id: 'sess1' }, secret: 's'.repeat(32) }
const TARGET: ShareLinkTarget = {
  resource: LINK.resource,
  organizationId: 'org1',
  opensAs: { kind: 'member', role: 'editor' },
  host: { hostId: 'host-a', routes: [{ kind: 'tunnel', url: 'https://h-host-a.solus.sh' }] },
}

describe('what a share link opens', () => {
  test('a member opens the app address on the workspace service, with the runner to dial first', () => {
    const opening = shareLinkOpening({ kind: 'resolved', target: TARGET }, LINK, ORIGIN)
    expect(opening).toEqual({ kind: 'member', address: appLinkUrl(ORIGIN, LINK.resource, solusApiId('org1')), runnerHostId: 'host-a' })
  })

  test('a guest dials the runner first, with the API copy as the fallback', () => {
    const opening = shareLinkOpening({ kind: 'resolved', target: { ...TARGET, opensAs: { kind: 'guest', role: 'viewer' } } }, LINK, ORIGIN)
    expect(opening).toEqual({ kind: 'guest', host: [{ kind: 'tunnel', url: 'https://h-host-a.solus.sh' }], mirror: ORIGIN })
  })

  test('a page a host serves dials that host and has no copy to fall to', () => {
    expect(shareLinkOpening({ kind: 'no-door' }, LINK, 'http://10.0.0.2:3001')).toEqual({ kind: 'guest', host: [{ kind: 'lan', url: 'http://10.0.0.2:3001' }], mirror: null })
    // The page's origin names its route kind: a tailnet address is a tailnet route.
    expect(shareLinkOpening({ kind: 'no-door' }, LINK, 'https://box.tail1234.ts.net')).toEqual({ kind: 'guest', host: [{ kind: 'tailnet', url: 'https://box.tail1234.ts.net' }], mirror: null })
  })

  test('an unknown link opens nothing and says so', () => {
    expect(shareLinkOpening({ kind: 'unknown-link' }, LINK, ORIGIN).kind).toBe('failed')
  })
})
