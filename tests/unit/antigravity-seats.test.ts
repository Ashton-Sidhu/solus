import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SeatManager } from '@solus/server/execution/seats/seat-manager'
import { SeatConnector } from '@solus/server/execution/seats/seat-connect'
import { enterpriseCallbackOf, parseEnterpriseLink, type EnterpriseSignInOptions } from '@solus/server/execution/seats/antigravity-enterprise-sign-in'
import { providerLoginConnected } from '@solus/server/execution/seats/seat-login'
import { antigravitySignInUrl } from '@solus/server/execution/agents/acp/antigravity'
import { runSqliteSchemaMigrations } from '@solus/server/db/sqlite-migrations'
import { AgentSoftware } from '@solus/server/updates/agent-software'
import { AntigravitySoftwareAdapter, antigravityTarget } from '@solus/server/updates/antigravity-software-adapter'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { installTestIdentities } from './helpers/acting-identities'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

installTestIdentities()
actAsHostForTests()

const BOB: Seat = { kind: 'user', userId: { kind: 'account', accountId: 'bob' }, name: 'Bob' }

function manager(db = new Database(':memory:') as unknown as DatabaseSync) {
  const root = temporaryRoot('agy-seats-')
  runSqliteSchemaMigrations(db, 'sqlite', 'agy-seats-test.db')
  const seats = new SeatManager({
    db,
    seatsRoot: join(root, 'seats'),
    hostClaudeDir: join(root, 'home', '.claude'),
    hostCodexHome: join(root, 'home', '.codex'),
    hostAntigravityProfile: join(root, 'data', 'agents', 'agy', 'profile'),
    hostLoginConnected: async () => false,
    memberLoginConnected: providerLoginConnected,
  })
  return { seats, root, db }
}

describe('Antigravity seats', () => {
  test('a member’s pasted Gemini key is their own private credential, and a turn runs in their own profile', async () => {
    const { seats, root } = manager()
    const status = await seats.storeToken(BOB, 'antigravity', 'AIzaSy-test-key-123\n')
    expect(status).toMatchObject({ provider: 'antigravity', state: 'connected', method: 'token', usageCapable: false })
    const turn = await seats.resolveForTurn(BOB, 'antigravity')
    expect(turn?.home).toBe(seats.homeFor(BOB, 'antigravity'))
    expect(turn!.home.startsWith(join(root, 'seats', 'antigravity'))).toBe(true)
    const record = join(turn!.home, 'solus-sign-in.json')
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ method: 'gemini-api-key', apiKey: 'AIzaSy-test-key-123' })
    expect(statSync(record).mode & 0o777).toBe(0o600)
    // Antigravity's history is Solus's kept history: the profile links no host transcripts.
    expect(existsSync(join(turn!.home, 'projects'))).toBe(false)
    expect(existsSync(join(turn!.home, 'sessions'))).toBe(false)
  })

  test('a member with no Antigravity sign-in is asked to connect before a turn starts', async () => {
    const { seats } = manager()
    await expect(seats.resolveForTurn(BOB, 'antigravity')).rejects.toThrow('Connect your Google Antigravity account on this host to run a turn.')
  })

  test('a Google sign-in that agy wrote into the seat’s profile is found, and disconnect removes it', async () => {
    const { seats, root } = manager()
    const profile = join(root, 'seats', 'antigravity', 'bob', 'antigravity-acp')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'acp_token.json'), '{}')
    expect(await seats.status(BOB, 'antigravity')).toMatchObject({ state: 'connected', method: 'login' })
    const home = seats.homeFor(BOB, 'antigravity')
    await seats.disconnect(BOB, 'antigravity')
    expect(existsSync(join(home, 'antigravity-acp', 'acp_token.json'))).toBe(false)
    expect((await seats.status(BOB, 'antigravity')).state).toBe('none')
  })

  test('the host login’s Antigravity profile is Solus’s own folder, not agy’s keyring default', async () => {
    const { seats, root } = manager()
    expect(seats.homeFor(HOST_LOGIN_SEAT, 'antigravity')).toBe(join(root, 'data', 'agents', 'agy', 'profile'))
    expect((await seats.status(HOST_LOGIN_SEAT, 'antigravity')).usageCapable).toBe(false)
  })

  test('a seat table made before Antigravity takes Antigravity rows and keeps its old rows', async () => {
    const db = new Database(':memory:') as unknown as DatabaseSync
    db.exec(`CREATE TABLE provider_seat (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex')),
      state TEXT NOT NULL CHECK (state IN ('connecting', 'connected', 'expired')),
      method TEXT CHECK (method IN ('login', 'token')),
      error TEXT,
      connected_at INTEGER,
      last_used_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, provider)
    )`)
    db.prepare("INSERT INTO provider_seat VALUES ('bob', 'codex', 'expired', 'login', 'refused', 1, 2, 3)").run()
    const { seats } = manager(db)
    await seats.storeToken(BOB, 'antigravity', 'AIzaSy-test-key-123')
    const rows = db.prepare('SELECT user_id, provider, state FROM provider_seat ORDER BY provider').all()
    expect(rows).toEqual([
      { user_id: 'bob', provider: 'antigravity', state: 'connected' },
      { user_id: 'bob', provider: 'codex', state: 'expired' },
    ])
  })
})

describe('Antigravity Vertex AI and Gemini Enterprise seats', () => {
  const VERTEX = { method: 'agent-platform' as const, gcpProject: 'my-project-123', gcpLocation: 'us-central1' }

  test('Vertex AI takes pasted Application Default Credentials, and a later key replaces them', async () => {
    const { seats } = manager()
    const home = seats.homeFor(BOB, 'antigravity')
    await seats.storeToken(BOB, 'antigravity', JSON.stringify({ type: 'authorized_user', client_id: 'c', refresh_token: 'r' }), VERTEX)
    expect(statSync(join(home, 'solus-application-default-credentials.json')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(home, 'solus-sign-in.json'), 'utf8'))).toEqual(VERTEX)
    expect((await seats.status(BOB, 'antigravity')).state).toBe('connected')

    await seats.storeToken(BOB, 'antigravity', 'AIzaSy-cloud-key-1', VERTEX)
    expect(existsSync(join(home, 'solus-application-default-credentials.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(home, 'solus-sign-in.json'), 'utf8'))).toEqual({ ...VERTEX, apiKey: 'AIzaSy-cloud-key-1' })
  })

  test('a credential that is neither a key nor Application Default Credentials is refused', async () => {
    const { seats } = manager()
    await expect(seats.storeToken(BOB, 'antigravity', '{"not":"credentials"}', VERTEX)).rejects.toThrow('application_default_credentials.json')
  })

  test('a Gemini Enterprise sign-in relays the browser’s address to agy, and a reconnect keeps the project', async () => {
    const { seats } = manager()
    const submitted: string[] = []
    const starts: EnterpriseSignInOptions[] = []
    let accept!: () => void
    const connector = new SeatConnector({
      seats,
      startEnterprise: async (options) => {
        starts.push(options)
        const done = new Promise<void>((resolve) => { accept = resolve })
        return { verificationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s', submit: async (value) => { submitted.push(value) }, cancel: () => {}, done }
      },
    })
    const enterprise = { method: 'oauth-business' as const, gcpProject: 'my-project-123', gcpLocation: 'global' }
    const started = await connector.start(BOB, 'antigravity', undefined, enterprise)
    expect(started).toEqual({ verificationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s', requiresCodeInput: true, input: 'redirect-url' })
    expect(starts[0]).toMatchObject({ gcpProject: 'my-project-123', gcpLocation: 'global', profile: seats.homeFor(BOB, 'antigravity') })
    await connector.submitCode(BOB, 'antigravity', 'http://127.0.0.1:4567/?state=s&code=c')
    expect(submitted).toEqual(['http://127.0.0.1:4567/?state=s&code=c'])
    accept()
    while ((await seats.status(BOB, 'antigravity')).state !== 'connected') await new Promise((resolve) => setTimeout(resolve, 1))
    expect(JSON.parse(readFileSync(join(seats.homeFor(BOB, 'antigravity'), 'solus-sign-in.json'), 'utf8'))).toMatchObject(enterprise)

    // `/login` names no method: the seat signs in to the same project again.
    await connector.start(BOB, 'antigravity')
    expect(starts[1]).toMatchObject({ gcpProject: 'my-project-123', gcpLocation: 'global' })
  })

  test('only Google’s link with a loopback redirect is relayed, and only this sign-in’s answer goes back', () => {
    const link = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2F'
    const pending = parseEnterpriseLink(link)
    expect(pending).toEqual({ authorizationUrl: link, redirectUri: 'http://127.0.0.1:4567/', state: 'abc' })
    expect(parseEnterpriseLink(link.replace('accounts.google.com', 'evil.example'))).toBeNull()
    expect(parseEnterpriseLink(link.replace('127.0.0.1%3A4567', 'example.com%3A4567'))).toBeNull()
    expect(enterpriseCallbackOf(pending!, 'http://127.0.0.1:4567/?state=abc&code=xyz').searchParams.get('code')).toBe('xyz')
    expect(() => enterpriseCallbackOf(pending!, 'http://127.0.0.1:4567/?state=other&code=xyz')).toThrow('does not belong')
    expect(() => enterpriseCallbackOf(pending!, 'http://127.0.0.1:9999/?state=abc&code=xyz')).toThrow('does not belong')
    expect(() => enterpriseCallbackOf(pending!, 'http://127.0.0.1:4567/?state=abc')).toThrow('whole address')
  })
})

describe('Antigravity sign-in output', () => {
  test('only a whole Google sign-in line is taken as the link', () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=s&response_type=code'
    expect(antigravitySignInUrl(`Opening sign-in\n${url}`)).toBeNull()
    expect(antigravitySignInUrl(`Opening sign-in\n${url}\nPaste the code: `)).toBe(url)
    expect(antigravitySignInUrl('https://evil.example/o/oauth2/auth?x\n')).toBeNull()
  })
})

describe('Antigravity managed install', () => {
  const GOOGLE = 'https://storage.googleapis.com/antigravity-public/antigravity-cli'

  test.each([
    ['darwin', 'arm64', false, 'darwin_arm64'],
    ['linux', 'x64', false, 'linux_amd64'],
    ['linux', 'arm64', true, 'linux_arm64_musl'],
    ['win32', 'x64', false, 'windows_amd64'],
  ] as const)('reads the manifest of %s/%s', (platform, arch, musl, target) => {
    expect(antigravityTarget(platform, arch, musl)).toBe(target)
  })

  test('a release that points outside Google’s package folder is refused before any download', async () => {
    const downloads: string[] = []
    const software = new AgentSoftware(new AntigravitySoftwareAdapter({
      platform: 'darwin',
      arch: 'arm64',
      metadata: async () => JSON.stringify({ version: '1.5.12', url: 'https://evil.example/cli_mac_arm64.tar.gz', sha512: 'a'.repeat(128) }),
    }), { root: temporaryRoot('agy-install-'), existingBinary: () => null, download: async (url) => { downloads.push(url) } })
    await expect(software.install()).rejects.toThrow('unexpected download address')
    expect(downloads).toEqual([])
  })

  test('the download must match Google’s SHA-512, and a match is selected for new turns', async () => {
    const payload = Buffer.from('agy executable')
    const sha512 = createHash('sha512').update(payload).digest('hex')
    const root = temporaryRoot('agy-install-')
    const install = (digest: string) => new AgentSoftware(new AntigravitySoftwareAdapter({
      platform: 'win32',
      arch: 'x64',
      metadata: async (url) => {
        expect(url).toBe('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json')
        return JSON.stringify({ version: '1.5.12', url: `${GOOGLE}/1.5.12-7/windows-x64/cli_windows_x64.exe`, sha512: digest })
      },
    }), {
      root,
      existingBinary: () => null,
      download: async (_url, destination) => { writeFileSync(destination, payload) },
      verify: async () => {},
      version: async () => null,
    }).install()
    await expect(install('b'.repeat(128))).rejects.toThrow('SHA-512 verification')
    await install(sha512)
    const selection = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'))
    expect(selection).toMatchObject({ version: '1.5.12', binary: 'agy.exe' })
    expect(readFileSync(join(root, 'releases', selection.release, 'agy.exe'), 'utf8')).toBe('agy executable')
  })
})

describe('Antigravity seats where each member is a Linux user', () => {
  test('a restart that loses the member’s Antigravity sign-in leaves their seat not connected', async () => {
    // WHY: there the seat folders are in memory (`/run`), and the seat row is in the
    // database, which the backup keeps. After a restart the row said `connected` while
    // the sign-in was gone, so the member saw a seat that no turn could use.
    const { MemberUsers, useMemberUsers } = await import('@solus/server/host/member-users')
    const { seats, root, db } = manager()
    const usersFile = join(root, 'member-users.json')
    writeFileSync(usersFile, JSON.stringify({
      layout: { switch: '/usr/bin/switch', shared: '/shared', reviews: '/reviews' },
      users: [{ userId: 'bob', username: 'bob', uid: 20000, home: join(root, 'members', 'bob'), secrets: join(root, 'seats', 'github', 'bob') }],
    }))
    useMemberUsers(new MemberUsers(usersFile))
    try {
      const profile = join(root, 'seats', 'antigravity', 'bob')
      const connect = () => db.prepare("INSERT OR REPLACE INTO provider_seat (user_id, provider, state, method, error, connected_at, last_used_at, updated_at) VALUES ('bob', 'antigravity', 'connected', 'login', NULL, 1, 1, 1)").run()

      // The sign-in is in the profile: the seat stays connected.
      mkdirSync(profile, { recursive: true })
      writeFileSync(join(profile, 'solus-sign-in.json'), JSON.stringify({ method: 'oauth-personal', verifiedAt: 1 }))
      connect()
      expect((await seats.status(BOB, 'antigravity')).state).toBe('connected')

      // The restart emptied the profile: the seat is not connected, and a turn asks for a sign-in.
      rmSync(profile, { recursive: true, force: true })
      mkdirSync(profile, { recursive: true })
      const fresh = new SeatManager({
        db,
        seatsRoot: join(root, 'seats'),
        hostClaudeDir: join(root, 'home', '.claude'),
        hostCodexHome: join(root, 'home', '.codex'),
        hostAntigravityProfile: join(root, 'data', 'agents', 'agy', 'profile'),
        hostLoginConnected: async () => false,
        memberLoginConnected: providerLoginConnected,
      })
      expect((await fresh.status(BOB, 'antigravity')).state).toBe('none')
      expect(db.prepare("SELECT COUNT(*) AS rows FROM provider_seat WHERE user_id = 'bob'").get()).toEqual({ rows: 0 })
      connect()
      await expect(new SeatManager({
        db,
        seatsRoot: join(root, 'seats'),
        hostClaudeDir: join(root, 'home', '.claude'),
        hostCodexHome: join(root, 'home', '.codex'),
        hostAntigravityProfile: join(root, 'data', 'agents', 'agy', 'profile'),
        hostLoginConnected: async () => false,
        memberLoginConnected: providerLoginConnected,
      }).resolveForTurn(BOB, 'antigravity')).rejects.toMatchObject({ state: 'none' })
    } finally {
      useMemberUsers(null)
    }
  })
})
