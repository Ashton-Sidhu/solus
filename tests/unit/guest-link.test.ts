import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cloudShareUrl, parseCloudShareLink } from '@solus/contracts/sharing'
import {
  guestRouteUrl,
  loadGuestIdentity,
  resolveShareLink,
  newGuestId,
  saveGuestIdentity,
} from '@solus/client-core/guest-link'

// docs/plans/multiplayer-sharing.md §4.2: a share link is `#/h/<hostId>/s/<secret>` on
// the account origin. The visitor keeps one identity in the browser; the origin answers
// the host's routes for the secret; the page dials the first route it can open.

describe('cloud resource links', () => {
  test('works and sessions keep the secret in the fragment; host links and task links open nothing', () => {
    for (const kind of ['work', 'session'] as const) {
      const resource = { kind, id: 'resource-1' }
      const secret = 'a'.repeat(43)
      const url = new URL(cloudShareUrl('https://app.example.test', resource, secret))
      expect(parseCloudShareLink(url.pathname, url.hash)).toEqual({ resource, secret })
      expect(url.search).toBe('')
    }
    expect(parseCloudShareLink('/app/', '#/h/host/s/secret')).toBeNull()
    expect(parseCloudShareLink('/w/id', '#short')).toBeNull()
    expect(parseCloudShareLink('/w/../id', '#' + 'a'.repeat(43))).toBeNull()
    // WHY: a task has no link of its own; its organization sees it (cloud-sharing.md §4a).
    expect(parseCloudShareLink('/t/resource-1', '#' + 'a'.repeat(43))).toBeNull()
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

describe('resolving a share link', () => {
  test('posts the secret, with the page\'s token when signed in, and keeps whom it opens as', async () => {
    // WHY: docs/plans/instant-share-open.md — one request answers what the link opens
    // and whom it opens it as; the token is how the API knows a member, and a page
    // that is signed out sends none.
    const calls: Array<{ url: string; body: string; authorization: string | null }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body), authorization: new Headers(init?.headers).get('authorization') })
      return Response.json({ resource: { kind: 'session', id: 's1' }, organizationId: 'org-1', opensAs: { kind: 'member', role: 'editor' }, host: { hostId: 'abcdefghijklmnop', routes: [{ kind: 'tunnel', url: 'https://h-abcdefghijklmnop.solus.sh' }] } })
    }
    const resolution = await resolveShareLink('https://app.solus.sh', 'secretsecretsecretsecretsecretsecret', 'api-token', fetchImpl)
    expect(resolution.kind === 'resolved' && resolution.target.opensAs).toEqual({ kind: 'member', role: 'editor' })
    expect(resolution.kind === 'resolved' && resolution.target.host?.routes).toEqual([{ kind: 'tunnel', url: 'https://h-abcdefghijklmnop.solus.sh' }])
    expect(calls[0]?.url).toBe('https://app.solus.sh/auth/share-link')
    expect(calls[0]?.authorization).toBe('Bearer api-token')
    expect(JSON.parse(calls[0]!.body)).toEqual({ shareSecret: 'secretsecretsecretsecretsecretsecret' })
    await resolveShareLink('https://app.solus.sh', 'secretsecretsecretsecretsecretsecret', null, fetchImpl)
    expect(calls[1]?.authorization).toBeNull()
  })

  test('the API\'s named 404 opens nothing; a host\'s unnamed 404 means the host serves the page', async () => {
    // WHY: a host has no resolve door and answers the path with its own 404 (`{ error: 'not found' }`);
    // the API's 404 names SHARE_LINK_UNKNOWN. That is how the page tells which origin
    // serves it, since a host also answers `/v1/hosts` with a JSON 401 and fools the cloud probe.
    const refused: typeof fetch = async () => Response.json({ error: { code: 'SHARE_LINK_UNKNOWN' } }, { status: 404 })
    expect(await resolveShareLink('https://app.solus.sh', 'x', null, refused)).toEqual({ kind: 'unknown-link' })
    const garbled: typeof fetch = async () => Response.json({ resource: { kind: 'session', id: 's1' } })
    expect(await resolveShareLink('https://app.solus.sh', 'x', null, garbled)).toEqual({ kind: 'unknown-link' })
    const host: typeof fetch = async () => Response.json({ error: 'not found' }, { status: 404 })
    expect(await resolveShareLink('http://10.0.0.2:3001', 'x', null, host)).toEqual({ kind: 'no-door' })
  })

  test('the page dials the first route it can open: no http route from an https page', () => {
    const routes = [{ kind: 'tunnel' as const, url: 'https://h-x.solus.sh' }, { kind: 'direct' as const, url: 'http://192.168.1.2:3000' }]
    expect(guestRouteUrl(routes, 'https://app.solus.sh')).toBe('https://h-x.solus.sh')
    expect(guestRouteUrl(routes, 'http://127.0.0.1:5000')).toBe('http://192.168.1.2:3000')
    expect(guestRouteUrl([], 'https://app.solus.sh')).toBeNull()
  })
})
