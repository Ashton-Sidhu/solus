import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { guestLinkFragment, parseGuestLinkFragment } from '@solus/contracts/sharing'
import {
  guestRouteUrl,
  loadGuestIdentity,
  mintGuestGrant,
  newGuestId,
  saveGuestIdentity,
} from '@solus/client-core/guest-link'

// docs/plans/multiplayer-sharing.md §4.2: a share link is `#/h/<hostId>/s/<secret>` on
// the account origin. The visitor keeps one identity in the browser; the origin mints a
// guest grant that names the host's route; the page dials the first route it can open.

describe('the guest link fragment', () => {
  test('round-trips through the parser and rejects anything else', () => {
    expect(parseGuestLinkFragment(guestLinkFragment('abcdefghijklmnop', 's3cret-_x'))).toEqual({ hostId: 'abcdefghijklmnop', secret: 's3cret-_x' })
    expect(parseGuestLinkFragment('/h/abc/s/def')).toEqual({ hostId: 'abc', secret: 'def' })
    // A workspace route, an empty hash, or a secret with a path in it is not a link.
    expect(parseGuestLinkFragment('#/chat/abc~local')).toBeNull()
    expect(parseGuestLinkFragment('')).toBeNull()
    expect(parseGuestLinkFragment('#/h/abc/s/de/f')).toBeNull()
  })
})

describe('the guest identity', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    // SAFETY: the tests need only the three methods the module calls.
    globalThis.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    } as unknown as Storage
  })
  afterEach(() => {
    // SAFETY: restoring the test process to its state before the fake.
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  test('is absent until saved, then returns the same person', () => {
    expect(loadGuestIdentity()).toBeNull()
    const guestId = newGuestId()
    expect(guestId).toMatch(/^[a-z0-9]{24}$/)
    saveGuestIdentity({ guestId, displayName: 'Maya' })
    expect(loadGuestIdentity()).toEqual({ guestId, displayName: 'Maya' })
  })

  test('a corrupt or foreign record reads as no identity', () => {
    store.set('solus.guest', '{"guestId":"short","displayName":"x"}')
    expect(loadGuestIdentity()).toBeNull()
    store.set('solus.guest', 'not json')
    expect(loadGuestIdentity()).toBeNull()
  })
})

describe('minting a guest grant', () => {
  test('posts the identity to the account origin and keeps the routes the grant names', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) })
      return Response.json({
        grant: 'g.r.ant', hostId: 'abcdefghijklmnop', expiresAt: 1, guestId: 'abcdefghijklmnopqrstuvwx', displayName: 'Maya',
        routes: [{ kind: 'tunnel', url: 'https://h-abcdefghijklmnop.solus.sh' }],
      })
    }
    const grant = await mintGuestGrant('https://app.solus.sh', 'abcdefghijklmnop', { guestId: 'abcdefghijklmnopqrstuvwx', displayName: 'Maya' }, fetchImpl)
    expect(grant?.routes).toEqual([{ kind: 'tunnel', url: 'https://h-abcdefghijklmnop.solus.sh' }])
    expect(calls[0]?.url).toBe('https://app.solus.sh/v1/hosts/abcdefghijklmnop/guest-grant')
    expect(JSON.parse(calls[0]!.body)).toEqual({ guestId: 'abcdefghijklmnopqrstuvwx', displayName: 'Maya' })
  })

  test('a refusal or an answer without routes is no grant', async () => {
    const refused: typeof fetch = async () => new Response('', { status: 404 })
    expect(await mintGuestGrant('https://app.solus.sh', 'x', { guestId: 'abcdefghijklmnopqrstuvwx', displayName: 'M' }, refused)).toBeNull()
    const legacy: typeof fetch = async () => Response.json({ grant: 'g', hostId: 'x', expiresAt: 1, guestId: 'abcdefghijklmnopqrstuvwx', displayName: 'M' })
    expect(await mintGuestGrant('https://app.solus.sh', 'x', { guestId: 'abcdefghijklmnopqrstuvwx', displayName: 'M' }, legacy)).toBeNull()
  })

  test('the page dials the first route it can open: no http route from an https page', () => {
    const routes = [{ kind: 'tunnel' as const, url: 'https://h-x.solus.sh' }, { kind: 'direct' as const, url: 'http://192.168.1.2:3000' }]
    expect(guestRouteUrl(routes, 'https://app.solus.sh')).toBe('https://h-x.solus.sh')
    expect(guestRouteUrl(routes, 'http://127.0.0.1:5000')).toBe('http://192.168.1.2:3000')
    expect(guestRouteUrl([], 'https://app.solus.sh')).toBeNull()
  })
})
