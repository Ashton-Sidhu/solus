import { describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { CloudAccountClient, MOBILE_DEVICE_CLIENT_ID } from '../../apps/mobile/src/features/account/account-client'
import { AccountSession } from '../../apps/mobile/src/features/account/account-session'
import { HostRegistry } from '../../apps/mobile/src/features/hosts/host-registry'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import { flushPromises } from './helpers/native-mobile-fakes'

const ORIGIN = 'https://app.solus.sh'

const host = (installationId: string, organizationIds: string[] = []): DirectoryHost => ({
  hostId: `h-${installationId}`,
  installationId,
  label: installationId,
  routes: [{ kind: 'tunnel', url: `https://${installationId}.tunnel` }],
  kind: 'personal',
  category: 'personal',
  organizationIds,
})

interface CloudScript {
  deviceCode?: number
  tokenAnswers?: Array<{ status: number; body: object }>
  hosts?: DirectoryHost[]
  accountStatus?: number
  /** Resolves the directory read when the test says so. */
  directoryGate?: Promise<void>
  grantGate?: Promise<void>
  grantStatus?: number
}

function fakeCloud(script: CloudScript) {
  const requests: Array<{ path: string; auth: string | null; body: string | null }> = []
  const tokenAnswers = [...(script.tokenAnswers ?? [{ status: 200, body: { access_token: 'session-1' } }])]
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice(ORIGIN.length)
    const headers = new Headers(init?.headers)
    requests.push({ path, auth: headers.get('authorization'), body: typeof init?.body === 'string' ? init.body : null })
    const json = (status: number, body: object) => new Response(JSON.stringify(body), { status })
    switch (path) {
      case '/api/auth/device/code':
        if (script.deviceCode && script.deviceCode !== 200) return json(script.deviceCode, { error: 'invalid_client' })
        return json(200, {
          device_code: 'dc', user_code: 'BCDFGHJK',
          verification_uri: `${ORIGIN}/device`, verification_uri_complete: `${ORIGIN}/device?user_code=BCDFGHJK`,
          expires_in: 900, interval: 5,
        })
      case '/api/auth/device/token': {
        const answer = tokenAnswers.shift() ?? { status: 400, body: { error: 'authorization_pending' } }
        return json(answer.status, answer.body)
      }
      case '/api/account/me':
        return json(200, { id: 'user-1', email: 'a@b.c', name: 'Ada', avatarUrl: null })
      case '/api/account/device-label':
        return new Response(null, { status: 204 })
      case '/v1/account':
        if (script.accountStatus) return json(script.accountStatus, { error: 'unauthorized' })
        return json(200, {
          userId: 'user-1', onboardingCompletedAt: null, activeOrganizationId: 'org-1',
          organizations: [{ organizationId: 'org-1', name: 'Acme', role: 'member', mayCreateManagedHost: false, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: false } }],
        })
      case '/v1/hosts':
        await script.directoryGate
        return json(200, {
          hosts: script.hosts ?? [],
          workspaces: [{ organizationId: 'org-1', label: 'Acme', routes: [], isActive: true, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: false } }],
        })
      case '/api/auth/sign-out':
        return json(200, {})
      default:
        if (path.startsWith('/v1/hosts/') && path.endsWith('/access-token')) {
          await script.grantGate
          if (script.grantStatus) return json(script.grantStatus, {})
          return json(200, { accessToken: `jwt-${path.split('/')[3]}`, hostId: path.split('/')[3], expiresAt: 8 * 60 * 60 * 1000 })
        }
        return json(404, {})
    }
  }) as typeof fetch
  return { fetchImpl, requests }
}

function world(script: CloudScript) {
  const cloud = fakeCloud(script)
  const storage = memoryKeyValueStore()
  const secrets = memorySecretStore()
  const registry = new HostRegistry(storage, secrets)
  const opened: string[] = []
  let now = 0
  const session = new AccountSession({
    client: new CloudAccountClient(ORIGIN, cloud.fetchImpl),
    registry,
    secrets,
    storage,
    fetch: cloud.fetchImpl,
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw new Error('aborted')
      now += ms
    },
    openBrowser: async (url) => void opened.push(url),
    deviceLabel: 'iPhone',
  })
  return { cloud, storage, secrets, registry, session, opened, advance: (ms: number) => { now += ms } }
}

describe('native Solus account', () => {
  test('device sign-in opens the browser, stores the session in the keychain, and reads hosts', async () => {
    const { cloud, secrets, registry, session, opened } = world({ hosts: [host('inst-1', ['org-1'])] })
    await registry.load()
    await session.load()
    expect(session.view.kind).toBe('signed-out')

    await session.startSignIn()
    expect(opened).toEqual([`${ORIGIN}/device?user_code=BCDFGHJK`])
    expect(session.view).toEqual({ kind: 'signed-in', profile: { id: 'user-1', email: 'a@b.c', name: 'Ada', avatarUrl: null }, origin: ORIGIN })
    expect(JSON.parse(cloud.requests[0]?.body ?? '{}')).toEqual({ client_id: MOBILE_DEVICE_CLIENT_ID })
    expect(secrets.values.has('solus.mobile.account')).toBe(true)
    expect(registry.hosts().map((entry) => entry.id)).toEqual(['inst-1'])
    expect(session.organizationId).toBe('org-1')
    // Every cloud call after sign-in is a bearer call; no cookie is assumed.
    expect(cloud.requests.filter((request) => request.path.startsWith('/v1/')).every((request) => request.auth === 'Bearer session-1')).toBe(true)
  })

  test('a code the person denies or lets expire ends sign-in without a spinner', async () => {
    const denied = world({ tokenAnswers: [{ status: 400, body: { error: 'access_denied' } }] })
    await denied.session.load()
    await denied.session.startSignIn()
    expect(denied.session.view).toEqual({ kind: 'signed-out', message: 'The sign-in was denied in the browser.' })

    const expired = world({ tokenAnswers: [{ status: 400, body: { error: 'expired_token' } }] })
    await expired.session.load()
    await expired.session.startSignIn()
    expect(expired.session.view.kind).toBe('signed-out')
  })

  test('cancelling sign-in returns to signed out and a late approval is dropped', async () => {
    const { session, secrets } = world({ tokenAnswers: [{ status: 400, body: { error: 'authorization_pending' } }, { status: 200, body: { access_token: 'late' } }] })
    await session.load()
    const pending = session.startSignIn()
    await flushPromises()
    session.cancelSignIn()
    await pending
    expect(session.view).toEqual({ kind: 'signed-out' })
    expect(secrets.values.has('solus.mobile.account')).toBe(false)
  })

  test('until Solus Cloud registers this app, sign-in says so', async () => {
    const { session } = world({ deviceCode: 400 })
    await session.load()
    await session.startSignIn()
    expect(session.view).toEqual({ kind: 'signed-out', message: 'Solus Cloud does not accept sign-in from this app yet.' })
  })

  test('a directory answer that arrives after sign-out is not applied', async () => {
    let release!: () => void
    const directoryGate = new Promise<void>((resolve) => { release = resolve })
    const { session, registry } = world({ hosts: [host('inst-1')], directoryGate })
    await registry.load()
    await session.load()
    const signIn = session.startSignIn()
    for (let i = 0; i < 50 && session.directory.kind !== 'loading'; i += 1) await Promise.resolve()
    expect(session.directory.kind).toBe('loading')
    await session.signOut()
    release()
    await signIn
    expect(registry.hosts()).toEqual([])
    expect(session.view.kind).toBe('signed-out')
  })

  test('the session survives a restart; a revoked one ends the account and its cloud hosts, keeping paired ones', async () => {
    const script: CloudScript = { hosts: [host('inst-1')] }
    const first = world(script)
    await first.registry.load()
    await first.session.load()
    await first.session.startSignIn()
    await first.registry.savePaired({ id: 'inst-paired', label: 'Desk', url: 'http://d:1' }, 't')

    // A new process reads the same keychain and storage.
    const registry = new HostRegistry(first.storage, first.secrets)
    await registry.load()
    const restarted = new AccountSession({
      client: new CloudAccountClient(ORIGIN, first.cloud.fetchImpl),
      registry,
      secrets: first.secrets,
      storage: first.storage,
      fetch: first.cloud.fetchImpl,
      now: () => 0,
      sleep: async () => {},
      openBrowser: async () => {},
      deviceLabel: 'iPhone',
    })
    await restarted.load()
    expect(restarted.view.kind).toBe('signed-in')
    expect(registry.hosts()).toHaveLength(2)

    script.accountStatus = 401
    await restarted.refreshDirectory()
    expect(restarted.view).toEqual({ kind: 'signed-out', message: 'Your Solus session ended. Sign in again.' })
    expect(registry.hosts().map((entry) => entry.id)).toEqual(['inst-paired'])
    expect(first.secrets.values.has('solus.mobile.account')).toBe(false)
  })

  test('a host token names the selected organization only for a host in it', async () => {
    const { session, registry, cloud } = world({ hosts: [host('inst-org', ['org-1']), host('inst-personal')] })
    await registry.load()
    await session.load()
    await session.startSignIn()
    await session.acquireHostAccessToken(registry.host('inst-org')!)
    await session.acquireHostAccessToken(registry.host('inst-personal')!)
    const bodies = cloud.requests.filter((request) => request.path.endsWith('/access-token')).map((request) => JSON.parse(request.body ?? '{}'))
    expect(bodies).toEqual([{ organizationId: 'org-1' }, {}])
  })

  test('mobile reuses an eight-hour grant and combines a dial with record API acquisition', async () => {
    const { session, registry, cloud, advance } = world({ hosts: [host('inst-org', ['org-1'])] })
    await registry.load()
    await session.load()
    await session.startSignIn()
    const target = registry.host('inst-org')!
    const tokens = await Promise.all([session.acquireHostAccessToken(target), session.acquireHostAccessToken(target)])
    expect(tokens).toEqual(['jwt-h-inst-org', 'jwt-h-inst-org'])
    advance(7 * 60 * 60 * 1000)
    expect(await session.acquireHostAccessToken(target)).toBe(tokens[0])
    expect(cloud.requests.filter((r) => r.path.endsWith('/access-token'))).toHaveLength(1)
    advance(60 * 60 * 1000)
    await session.acquireHostAccessToken(target)
    expect(cloud.requests.filter((r) => r.path.endsWith('/access-token'))).toHaveLength(2)
  })

  test('mobile scopes grants by organization and forwards forced renewal', async () => {
    const { session, registry, cloud } = world({ hosts: [host('inst-org', ['org-1', 'org-2'])] })
    await registry.load()
    await session.load()
    await session.startSignIn()
    const target = registry.host('inst-org')!
    await session.acquireHostAccessToken(target)
    session.selectOrganization('org-2')
    await session.acquireHostAccessToken(target)
    await session.acquireHostAccessToken(target, { fresh: true })
    expect(cloud.requests.filter((r) => r.path.endsWith('/access-token')).map((r) => JSON.parse(r.body ?? '{}')))
      .toEqual([{ organizationId: 'org-1' }, { organizationId: 'org-2' }, { organizationId: 'org-2' }])
  })

  test('a mobile grant that finishes after sign-out is neither returned nor reused', async () => {
    let release!: () => void
    const grantGate = new Promise<void>((resolve) => { release = resolve })
    const { session, registry } = world({ hosts: [host('inst-org')], grantGate })
    await registry.load()
    await session.load()
    await session.startSignIn()
    const target = registry.host('inst-org')!
    const pending = session.acquireHostAccessToken(target)
    await session.signOut()
    release()
    expect(await pending).toBeNull()
    expect(await session.acquireHostAccessToken(target)).toBeNull()
  })
})
