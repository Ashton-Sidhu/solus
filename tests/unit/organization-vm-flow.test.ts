import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  ACCOUNT_AUDIENCE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  SOLUS_API_AUDIENCE,
  hostAudience,
  type AccessTokenClaims,
  type UplinkLinkConfig,
} from '@solus/contracts/uplink'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/010-standard-oauth.md across the real HTTP seams: a VM trades the access token
// its person's client presented for its own delegated tokens at the account plane's
// token endpoint (RFC 8693), once; the real Solus API admits the session before the
// provider would start; the agent's writes land in the API as that person; the VM's
// first session report travels with the person's delegated token and takes its owner
// from the admission. The account plane is a fake that signs real ES256 tokens; the
// API is the real one.

const VM = 'vmhost000000001'
const CLIENT = { clientId: `host_${VM}`, clientSecret: 'shc_vm_secret' }
const environment = ['SOLUS_DATA_DIR', 'SOLUS_API', 'SOLUS_DB', 'SOLUS_CLOUD_ISSUER', 'SOLUS_CLOUD_JWKS_URL', 'SOLUS_API_SIGNING_KEY'] as const
const previous = environment.map((key) => [key, process.env[key]] as const)

let directory: string
let service: Awaited<ReturnType<typeof import('@solus/server/boot-solus-api').bootSolusApi>> | undefined
let accountPlane: Server
let accountOrigin: string
let apiOrigin: string
let signingKey: KeyObject
const tokenRequests: Array<{ grantType: string; organizationId: string | null }> = []

function signed(claims: AccessTokenClaims): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'ES256', kid: 'plane-key', typ: 'at+jwt' })
  const body = encode(claims)
  return `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

const now = () => Math.floor(Date.now() / 1000)

/** The access token Bob's client presented to the VM: the account plane checks it names this VM. */
function bobsTokenForVm(): string {
  return signed({ iss: accountOrigin, aud: hostAudience(VM), sub: 'bob', deviceId: 'bob-session', jti: randomUUID(), iat: now(), exp: now() + 300, client_id: 'solus-app', access: 'org-member', organizationId: 'org_a', organizationRole: 'member', teamIds: [], hostKind: 'personal' })
}

/** What the account plane issues the VM for Bob in one organization: the VM acts, Bob is the subject. */
function delegatedFor(subject: string, organizationId: string): string {
  return signed({ iss: accountOrigin, aud: [SOLUS_API_AUDIENCE, ACCOUNT_AUDIENCE], sub: subject, deviceId: VM, jti: randomUUID(), iat: now(), exp: now() + 300, client_id: CLIENT.clientId, access: 'org-member', organizationId, organizationRole: 'member', teamIds: [], hostKind: 'cloud', email: 'bob@example.test', act: { sub: CLIENT.clientId, host_id: VM } })
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-organization-vm-flow-'))
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  signingKey = keys.privateKey
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'plane-key' }
  accountPlane = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const json = (status: number, body: object) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
      if (request.url === '/jwks') return json(200, { keys: [jwk] })
      if (request.url !== '/api/auth/oauth2/token') return json(404, { error: 'not found' })
      // The VM authenticates as its own confidential client.
      if (request.headers.authorization !== `Basic ${Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString('base64')}`) return json(401, { error: 'invalid_client' })
      const form = new URLSearchParams(raw)
      tokenRequests.push({ grantType: form.get('grant_type') ?? '', organizationId: form.get('organization_id') })
      if (form.get('grant_type') === TOKEN_EXCHANGE_GRANT_TYPE) {
        const subject = JSON.parse(Buffer.from(String(form.get('subject_token')).split('.')[1] ?? '', 'base64url').toString())
        if (subject.aud !== hostAudience(VM)) return json(400, { error: 'invalid_grant' })
        return json(200, { access_token: delegatedFor(subject.sub, form.get('organization_id')!), refresh_token: `refresh-${subject.sub}`, expires_in: 300, token_type: 'Bearer' })
      }
      if (form.get('grant_type') === 'refresh_token') return json(200, { access_token: delegatedFor('bob', 'org_a'), refresh_token: 'refresh-bob-2', expires_in: 300, token_type: 'Bearer' })
      json(400, { error: 'unsupported_grant_type' })
    })
  })
  await new Promise<void>((resolve) => accountPlane.listen(0, '127.0.0.1', resolve))
  const address = accountPlane.address()
  accountOrigin = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  Object.assign(process.env, {
    SOLUS_DATA_DIR: directory, SOLUS_API: '1', SOLUS_DB: process.env.SOLUS_DB ?? 'sqlite',
    SOLUS_CLOUD_ISSUER: accountOrigin, SOLUS_CLOUD_JWKS_URL: `${accountOrigin}/jwks`,
    SOLUS_API_SIGNING_KEY: Buffer.alloc(32, 21).toString('base64'),
  })
  const { bootSolusApi } = await import('@solus/server/boot-solus-api')
  service = await bootSolusApi({ host: '127.0.0.1', port: 0 })
  apiOrigin = `http://127.0.0.1:${service.port}`
})

afterAll(async () => {
  await service?.shutdown()
  await new Promise<void>((resolve) => accountPlane.close(() => resolve()))
  await resetTestDatabase()
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  rmSync(directory, { recursive: true, force: true })
})

const vmLink = (): UplinkLinkConfig => ({ hostId: VM, issuer: accountOrigin, jwksUrl: `${accountOrigin}/jwks`, directoryUrl: accountOrigin, hostname: 'h-vm.lab.invalid', proxiedPort: 1, connectionGeneration: 1, apiUrl: apiOrigin })

describe('an organization run on a VM, through the real Solus API', () => {
  test('one token exchange covers the admission, the agent\'s writes as the person, and the delivery that takes its owner from the admission', async () => {
    const { Delegations } = await import('@solus/server/sync/delegations')
    const { remoteWorkspaceOperations } = await import('@solus/server/sync/remote-operations')
    const { RunnerDelivery } = await import('@solus/server/sync/runner-delivery')
    const outbox = await import('@solus/server/sync/outbox/outbox-store')
    const records = await import('@solus/server/data/sessions/session-records')
    const admissions = await import('@solus/server/data/sessions/session-admissions')
    const shareManager = await import('@solus/server/sharing/share-manager')
    const database = await import('@solus/server/db/database')
    const link = vmLink()

    // 1. Admission: the VM trades Bob's token once; the API accepts the session.
    const delegations = new Delegations({ link: () => link, client: () => CLIENT, personToken: (userId) => (userId === 'bob' ? bobsTokenForVm() : null), onRevoked: () => {} })
    await delegations.actFor({ sessionId: 'solus-flow', userId: 'bob', organizationId: 'org_a', admit: true })
    expect(await admissions.readSessionAdmission('org_a', 'solus-flow')).toMatchObject({ hostId: VM, ownerUserId: 'bob' })
    // A retry answers the same admission; nobody else can take it.
    await delegations.actFor({ sessionId: 'solus-flow', userId: 'bob', organizationId: 'org_a', admit: true })

    // 2. The provider started; its record is reported with Bob's delegated token, naming the admission.
    const delivery = new RunnerDelivery({ link: () => link, delegations, linker: () => 'alice' })
    delivery.start()
    try {
      // The record is keyed by the session id the admission accepted, not by the provider thread.
      outbox.queueSessionReport({ organizationId: 'org_a', actorUserId: 'bob' }, { sessionId: 'solus-flow', provider: 'codex', projectPath: '-repo', lastActivityAt: Date.now(), title: 'Ship it', ownerUserId: 'mallory', admissionId: 'solus-flow' })
      const actor = delegations.actorOf('solus-flow')
      expect(actor).toEqual({ userId: 'bob', organizationId: 'org_a' })
      const operations = remoteWorkspaceOperations(delegations.apiClient(actor!.userId, actor!.organizationId), (recordId) => delivery.deliverSessionReport(recordId))

      // 3. The agent's writes go to the API as Bob, synchronously; the parent session is there by then.
      const context = { principal: { kind: 'system' as const }, home: { kind: 'local' as const, hostId: 'unused' }, scopes: [] }
      const task = await operations.createTask(context, { title: 'From the VM', originSessionId: 'solus-flow' }, randomUUID())
      expect(task).toMatchObject({ title: 'From the VM', organizationId: 'org_a', ownerUserId: 'bob', source: 'agent', home: { kind: 'organization', organizationId: 'org_a' } })
      expect(await operations.getTask(context, task.id)).toMatchObject({ id: task.id })
      const moved = await operations.updateTask(context, task.id, { status: 'in_review' }, task.version)
      expect(moved.status).toBe('in_review')
      const work = await operations.createWork(context, { title: 'VM notes', type: 'doc', content: '# Notes about the rollout plan', originSessionId: 'solus-flow' }, randomUUID())
      expect((await operations.getWork(context, work.id)).content).toBe('# Notes about the rollout plan')
      // Content search answers where the works live, for the works Bob may open.
      expect((await operations.searchWorks(context, { q: 'rollout' })).items.map((hit) => hit.id)).toEqual([work.id])
      expect((await operations.searchWorks(context, { q: 'nothing-like-this' })).items).toEqual([])
      // An import is read with Bob's own account connection on the API; with none connected it says so and creates nothing.
      await expect(operations.importWork(context, { url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/1/Plan', originSessionId: 'solus-flow' }, randomUUID())).rejects.toMatchObject({ status: 400 })
      expect((await operations.searchWorks(context, { q: 'ENG' })).items).toEqual([])
      // Publishing and pulling happen where the work lives, and say why they cannot.
      await expect(operations.publishWork(context, work.id, {})).rejects.toMatchObject({ status: 400, message: expect.stringContaining('never been published') })
      await expect(operations.pullWorkUpstream(context, work.id)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('not linked to an upstream document') })

      // 4. The API's record of the session: owned by Bob from the admission, never by the report or the linker.
      expect(await records.getSessionRecord('org_a', 'solus-flow')).toMatchObject({ ownerUserId: 'bob', runnerHostId: VM, title: 'Ship it' })
      const shares = new shareManager.ShareManager({ db: database.getDatabase() })
      expect(await shares.ownerOf({ kind: 'session', id: 'solus-flow' })).toBe('bob')
      expect(await shares.ownerOf({ kind: 'task', id: task.id })).toBe('bob')
      // WHY: nothing was asked of the account plane per prompt or per write — one exchange, no refresh yet.
      expect(tokenRequests).toEqual([{ grantType: TOKEN_EXCHANGE_GRANT_TYPE, organizationId: 'org_a' }])
    } finally {
      await delivery.stop()
    }
  })

  test('the API refuses a token meant for a host, and its runner routes refuse a person\'s token that no host acts with', async () => {
    // A person's token for the VM is not a credential at the API: wrong resource.
    const forVm = await fetch(`${apiOrigin}/v1/auth/session`, { method: 'POST', headers: { authorization: `Bearer ${bobsTokenForVm()}`, 'content-type': 'application/json' }, body: JSON.stringify({ scopes: ['tasks:write'] }) })
    expect(forVm.status).toBe(401)
    // A person's own API token, with no host acting for them, cannot deliver as a runner.
    const own = signed({ iss: accountOrigin, aud: SOLUS_API_AUDIENCE, sub: 'bob', deviceId: 'bob-session', jti: randomUUID(), iat: now(), exp: now() + 300, client_id: 'solus-app', access: 'org-member', organizationId: 'org_a', organizationRole: 'member', teamIds: [], hostKind: 'cloud' })
    const delivered = await fetch(`${apiOrigin}/runner/session-records`, { method: 'POST', headers: { authorization: `Bearer ${own}`, 'content-type': 'application/json' }, body: JSON.stringify({ hostId: VM, reports: [] }) })
    expect(delivered.status).toBe(401)
    // The acting host's delegated token opens them, for its own host id only.
    const asAnother = await fetch(`${apiOrigin}/runner/session-records`, { method: 'POST', headers: { authorization: `Bearer ${delegatedFor('bob', 'org_a')}`, 'content-type': 'application/json' }, body: JSON.stringify({ hostId: 'someone-else', reports: [] }) })
    expect(asAnother.status).toBe(403)
  })
})
