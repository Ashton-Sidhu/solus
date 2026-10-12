import { describe, expect, test } from 'bun:test'
import { ACCOUNT_AUDIENCE, hostAudience, type DirectoryHost } from '@solus/contracts/uplink'
import { SOLUS_CLIENT_IDS } from '@solus/contracts/auth/clients'
import { AccountSession } from '../../apps/mobile/src/features/account/account-session'
import {
  authSessionAuthorizer,
  callbackOf,
  MOBILE_REDIRECT_URI,
  type AuthSessionResult,
} from '../../apps/mobile/src/features/account/auth-session-authorizer'
import { ACCOUNT_GRANT_KEY, KeychainTokenStore } from '../../apps/mobile/src/features/account/keychain-token-store'
import { HostRegistry } from '../../apps/mobile/src/features/hosts/host-registry'
import { memoryKeyValueStore, memorySecretStore, type SecretStore } from '../../apps/mobile/src/platform/ports'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// The mobile account (ADR 0001 stage 1c): one OAuthSession as `solus-mobile`, the system
// authentication session with the claimed `solus://` redirect, the refresh token in the
// keychain, and five-minute access tokens for the account plane and for each host.

const host = (installationId: string, organizationIds: string[] = []): DirectoryHost => ({
  hostId: `h-${installationId}`,
  installationId,
  label: installationId,
  routes: [{ kind: 'tunnel', url: `https://${installationId}.tunnel` }],
  kind: 'personal',
  category: 'personal',
  organizationIds,
})

const ORGANIZATION = { organizationId: 'org-1', name: 'Acme', role: 'member', mayCreateManagedHost: false, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: false } }

interface CloudScript {
  hosts: DirectoryHost[]
  accountStatus?: number
  directoryGate?: Promise<void>
}

function world(script: CloudScript = { hosts: [] }, shared?: { secrets: SecretStore & { values: Map<string, string> }; storage: ReturnType<typeof memoryKeyValueStore>; plane: ReturnType<typeof fakeAccountPlane> }) {
  const plane = shared?.plane ?? fakeAccountPlane({ clientId: SOLUS_CLIENT_IDS.mobile, identity: { sub: 'user-1', email: 'ada@example.test', email_verified: true, name: 'Ada', picture: 'https://example.test/ada.png' } })
  const apiCalls: Array<{ path: string; authorization: string | null }> = []
  const json = (status: number, body: object) => new Response(JSON.stringify(body), { status })
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (!url.pathname.startsWith('/v1/')) return plane.fetch(String(input), init)
    apiCalls.push({ path: url.pathname, authorization: new Headers(init?.headers).get('authorization') })
    switch (url.pathname) {
      case '/v1/account':
        if (script.accountStatus) return json(script.accountStatus, { error: 'unavailable' })
        return json(200, { userId: 'user-1', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [ORGANIZATION] })
      case '/v1/hosts':
        await script.directoryGate
        return json(200, {
          hosts: script.hosts,
          workspaces: [{ organizationId: 'org-1', label: 'Acme', routes: [], isActive: false, policy: ORGANIZATION.policy }],
        })
    }
    return json(404, {})
  }) as typeof fetch
  const secrets = shared?.secrets ?? memorySecretStore()
  const storage = shared?.storage ?? memoryKeyValueStore()
  const registry = new HostRegistry(storage, secrets)
  const browser = { opened: [] as URL[], answer: 'approve' as 'approve' | 'deny' | 'close' }
  const authorizer = authSessionAuthorizer({
    async openAuthSession(url): Promise<AuthSessionResult> {
      const authorizeUrl = new URL(url)
      browser.opened.push(authorizeUrl)
      if (browser.answer === 'close') return { type: 'cancel' }
      const callback = plane.approve(authorizeUrl)
      if (browser.answer === 'deny') {
        callback.searchParams.delete('code')
        callback.searchParams.set('error', 'access_denied')
      }
      return { type: 'success', url: callback.toString() }
    },
    dismissAuthSession() {},
  })
  const session = new AccountSession({ cloudOrigin: ISSUER, registry, secrets, storage, fetch: fetchImpl, now: plane.now, authorizer })
  return { plane, apiCalls, secrets, storage, registry, session, browser }
}

async function signedIn(script?: CloudScript) {
  const w = world(script)
  await w.registry.load()
  await w.session.load()
  await w.session.startSignIn()
  await w.session.written()
  return w
}

describe('mobile browser step', () => {
  test('only a redirect to the app scheme is a callback', () => {
    expect(callbackOf({ type: 'success', url: `${MOBILE_REDIRECT_URI}?code=c&state=s` })?.searchParams.get('code')).toBe('c')
    expect(callbackOf({ type: 'success', url: 'https://evil.test/auth/callback?code=c' })).toBeNull()
    expect(callbackOf({ type: 'cancel' })).toBeNull()
    expect(callbackOf({ type: 'dismiss' })).toBeNull()
  })

  test('a cancelled step closes the session and gives no callback', async () => {
    let dismissed = 0
    let finish!: (result: AuthSessionResult) => void
    const authorization = await authSessionAuthorizer({
      openAuthSession: () => new Promise((resolve) => { finish = resolve }),
      dismissAuthSession: () => { dismissed += 1 },
    }).start()
    const pending = authorization.complete(new URL(`${ISSUER}/authorize`))
    authorization.cancel()
    finish({ type: 'success', url: `${MOBILE_REDIRECT_URI}?code=late&state=s` })
    expect(await pending).toBeNull()
    expect(dismissed).toBe(1)
  })
})

describe('mobile keychain token store', () => {
  test('a clear and a later save reach the keychain in order', async () => {
    const secrets = memorySecretStore()
    const store = new KeychainTokenStore(secrets)
    const grant = { refreshToken: 'rt', idToken: 'id', identity: { sub: 'u', email: 'e', emailVerified: true, name: null, picture: null }, signedInAt: 1 }
    store.save(grant)
    store.clear()
    store.save({ ...grant, refreshToken: 'rt-2' })
    await store.written()
    expect(JSON.parse(secrets.values.get(ACCOUNT_GRANT_KEY) ?? '{}').refreshToken).toBe('rt-2')
  })

  test('an entry of the old session-token form reads as signed out and is deleted', async () => {
    const secrets = memorySecretStore()
    await secrets.set(ACCOUNT_GRANT_KEY, JSON.stringify({ sessionToken: 'tok', origin: ISSUER, profile: { id: 'u', email: 'e', name: null, avatarUrl: null } }))
    const store = new KeychainTokenStore(secrets)
    await store.read()
    expect(store.load()).toBeNull()
    expect(secrets.values.has(ACCOUNT_GRANT_KEY)).toBe(false)
  })
})

describe('native Solus account', () => {
  test('sign-in uses the code flow with PKCE as solus-mobile and keeps the grant in the keychain', async () => {
    const { session, browser, secrets, registry, apiCalls, plane } = await signedIn({ hosts: [host('inst-1', ['org-1'])] })
    const query = browser.opened[0]!.searchParams
    expect(query.get('client_id')).toBe('solus-mobile')
    expect(query.get('redirect_uri')).toBe('solus://auth/callback')
    expect(query.get('code_challenge_method')).toBe('S256')
    expect(session.view).toEqual({
      kind: 'signed-in',
      identity: { sub: 'user-1', email: 'ada@example.test', emailVerified: true, name: 'Ada', picture: 'https://example.test/ada.png' },
      origin: ISSUER,
      isStale: false,
    })
    const stored = JSON.parse(secrets.values.get(ACCOUNT_GRANT_KEY) ?? '{}')
    expect(plane.isLive(stored.refreshToken)).toBe(true)
    expect(registry.hosts().map((entry) => entry.id)).toEqual(['inst-1'])
    expect(session.organizationId).toBe('org-1')
    // Every account call carries an access token for the account plane, never the refresh token.
    expect(apiCalls.length).toBeGreaterThan(0)
    expect(apiCalls.every((call) => call.authorization?.startsWith('Bearer at-') && call.authorization.includes(ACCOUNT_AUDIENCE))).toBe(true)
  })

  test('a denied sign-in says so; a closed page says nothing', async () => {
    const denied = world()
    await denied.session.load()
    denied.browser.answer = 'deny'
    await denied.session.startSignIn()
    expect(denied.session.view).toEqual({ kind: 'signed-out', message: 'The sign-in was denied in the browser.' })

    const closed = world()
    await closed.session.load()
    closed.browser.answer = 'close'
    await closed.session.startSignIn()
    expect(closed.session.view).toEqual({ kind: 'signed-out' })
  })

  test('hosts load even when the account read fails, and the organizations shown before stay', async () => {
    const script: CloudScript = { hosts: [host('inst-1', ['org-1'])] }
    const { session, registry } = await signedIn(script)
    expect(session.directory).toMatchObject({ kind: 'loaded', organizations: [ORGANIZATION] })

    script.accountStatus = 500
    script.hosts = [host('inst-1', ['org-1']), host('inst-2')]
    await session.refreshDirectory()
    expect(registry.hosts().map((entry) => entry.id)).toEqual(['inst-1', 'inst-2'])
    expect(session.directory).toMatchObject({ kind: 'loaded', organizations: [ORGANIZATION] })
  })

  test('a cold start reads the keychain and the identity again; a revoked grant ends the account, keeping paired hosts', async () => {
    const first = await signedIn({ hosts: [host('inst-1')] })
    await first.registry.savePaired({ id: 'inst-paired', label: 'Desk', url: 'http://d:1' }, 't')

    // A new process reads the same keychain and storage; the website renamed the person.
    first.plane.renameInUserinfo('Ada Lovelace')
    const restarted = world({ hosts: [host('inst-1')] }, { secrets: first.secrets, storage: first.storage, plane: first.plane })
    await restarted.registry.load()
    await restarted.session.load()
    expect(restarted.session.view).toMatchObject({ kind: 'signed-in', identity: { name: 'Ada' } })
    await restarted.session.refreshIdentity()
    expect(restarted.session.view).toMatchObject({ kind: 'signed-in', identity: { name: 'Ada Lovelace' } })
    expect(restarted.registry.hosts()).toHaveLength(2)

    // The grant ends elsewhere (the Devices page): the next refresh is refused.
    for (const token of first.plane.liveTokens()) await first.plane.fetch(`${ISSUER}/api/auth/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ token }).toString() })
    expect(await restarted.session.hostAccessToken(restarted.registry.host('inst-1')!, { fresh: true })).toBeNull()
    await restarted.session.written()
    expect(restarted.session.view).toEqual({ kind: 'signed-out', message: 'Your Solus session ended. Sign in again.' })
    expect(restarted.registry.hosts().map((entry) => entry.id)).toEqual(['inst-paired'])
    expect(first.secrets.values.has(ACCOUNT_GRANT_KEY)).toBe(false)
  })

  test('a host gets an access token for its own audience, and a dial names the organization it works in', async () => {
    const { session, registry } = await signedIn({ hosts: [host('inst-org', ['org-1', 'org-2']), host('inst-own')] })
    const shared = registry.host('inst-org')!
    expect(await session.hostAccessToken(shared)).toContain(hostAudience('h-inst-org'))
    expect(session.dialOrganizationId(shared)).toBe('org-1')
    session.selectOrganization('org-2')
    expect(session.dialOrganizationId(shared)).toBe('org-2')
    // The owner's own host: the token says `owner`, so the dial names none.
    expect(session.dialOrganizationId(registry.host('inst-own')!)).toBeNull()
  })

  test('sign-out revokes the grant at the account plane; a directory answer after it is not applied', async () => {
    let release!: () => void
    const directoryGate = new Promise<void>((resolve) => { release = resolve })
    const script: CloudScript = { hosts: [host('inst-1')] }
    const { session, registry, plane, secrets } = await signedIn(script)
    const refreshToken = JSON.parse(secrets.values.get(ACCOUNT_GRANT_KEY) ?? '{}').refreshToken
    script.directoryGate = directoryGate
    script.hosts = [host('inst-1'), host('inst-2')]
    const reading = session.refreshDirectory()
    await session.signOut()
    release()
    await reading
    await session.written()
    expect(plane.isLive(refreshToken)).toBe(false)
    expect(registry.hosts()).toEqual([])
    expect(session.view).toEqual({ kind: 'signed-out' })
    expect(secrets.values.has(ACCOUNT_GRANT_KEY)).toBe(false)
    expect(await session.hostAccessToken(host('inst-1') as never)).toBeNull()
  })
})
