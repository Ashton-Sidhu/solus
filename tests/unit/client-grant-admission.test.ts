import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { hostAudience, type DelegatedAccessTokenClaims, type PersonAccessTokenClaims } from '@solus/contracts/uplink'
import type { Principal } from '@solus/server/admission/principal'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { principalFor, renewalExpiry } = await import('@solus/server/admission/principal')
const { consumeWsTicket, resetAuthStateForTests, revokeDevice } = await import('@solus/server/admission/auth')
const { ticketForDelegatedMember, ticketForGrant } = await import('@solus/server/transport/http')
const { delegationScopesFor } = await import('@solus/server/sync/delegations')

// docs/adr/0001-standard-authentication.md §6.4 and §7 stage 2: a Solus client's token
// names its client grant and lists the organizations it may work in. A connection
// names one; the host admits only an organization the token lists. A host's delegated
// token names one organization itself, and the Solus API admits its person there.

const now = () => Math.floor(Date.now() / 1000)
const clientToken = (over: Partial<PersonAccessTokenClaims>): PersonAccessTokenClaims => ({
  iss: 'https://app.example.test', aud: hostAudience('abcdefghijklmnop'), sub: 'alice', grant_id: 'grant_1', client_id: 'solus-desktop',
  jti: crypto.randomUUID(), iat: now(), exp: now() + 300, ...over,
})
const delegated = (): DelegatedAccessTokenClaims => ({
  iss: 'https://app.example.test', aud: ['urn:solus:api', 'urn:solus:account'], sub: 'alice', client_id: 'host_h1',
  jti: crypto.randomUUID(), iat: now(), exp: now() + 300, act: { sub: 'host_h1', host_id: 'h1' }, grant_id: 'grant_1',
  access: 'org-member', hostKind: 'cloud', organizationId: 'org_a', organizationRole: 'member', teamIds: ['t1'],
})
const member = (over: Partial<PersonAccessTokenClaims> = {}) => clientToken({
  access: 'org-member', hostKind: 'personal', displayName: 'Alice',
  organizations: [{ id: 'org_a', role: 'member', teamIds: ['t1'] }, { id: 'org_b', role: 'owner', teamIds: [] }],
  ...over,
})

async function admitted(claims: PersonAccessTokenClaims, options: { workspace?: boolean; organizationId?: string } = {}): Promise<Principal> {
  const outcome = await ticketForGrant(claims, options)
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`)
  return principalFor({ kind: 'ticket', ticket: consumeWsTicket(outcome.ticket)! })
}

describe('a Solus client token at the ticket door', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-client-grant-'))
    process.env.SOLUS_DATA_DIR = dataDir
    resetAuthStateForTests()
  })

  afterEach(() => {
    resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test("the owner's token needs no organization, and the client grant keys the device", async () => {
    expect(await admitted(clientToken({ access: 'owner' }))).toMatchObject({ kind: 'remote-owner', userId: 'alice', deviceId: 'grant_1' })
  })

  test('a member is admitted in the organization the connection names, with that standing', async () => {
    expect(await admitted(member(), { organizationId: 'org_b' })).toMatchObject({ kind: 'org-member', organizationId: 'org_b', organizationRole: 'owner', teamIds: [] })
    expect(await admitted(member(), { organizationId: 'org_a' })).toMatchObject({ kind: 'org-member', organizationId: 'org_a', organizationRole: 'member', teamIds: ['t1'] })
  })

  test('an organization the token does not list is refused, and so is a member connection that names none', async () => {
    // WHY: the account plane decided where the person may work; a client cannot pick an organization outside that list.
    expect(await ticketForGrant(member(), { organizationId: 'org_c' })).toEqual({ ok: false, reason: 'organization-not-listed' })
    expect(await ticketForGrant(member())).toEqual({ ok: false, reason: 'organization-not-listed' })
    expect(await ticketForGrant(member({ aud: 'urn:solus:api', hostKind: 'cloud' }), { workspace: true, organizationId: 'org_c' })).toEqual({ ok: false, reason: 'organization-not-listed' })
  })

  test('the Solus API admits a member in a listed organization and never an owner token', async () => {
    expect(await admitted(member({ aud: 'urn:solus:api', hostKind: 'cloud' }), { workspace: true, organizationId: 'org_a' })).toMatchObject({ kind: 'org-member', organizationId: 'org_a', hostKind: 'cloud' })
    expect(await ticketForGrant(clientToken({ access: 'owner' }), { workspace: true })).toEqual({ ok: false, reason: 'member-required' })
  })

  test('a delegated token admits its person in the one organization it names, until the owner revokes the acting host', () => {
    // WHY: an organization delegation names one organization and the person's standing there (ADR 0001 §3.4).
    const outcome = ticketForDelegatedMember(delegated())
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(principalFor({ kind: 'ticket', ticket: consumeWsTicket(outcome.ticket)! })).toMatchObject({ kind: 'org-member', organizationId: 'org_a', teamIds: ['t1'], deviceId: 'h1' })
    revokeDevice('h1')
    expect(ticketForDelegatedMember(delegated())).toEqual({ ok: false, reason: 'device-revoked' })
  })

  test('a delegated token opens no socket of a person at a host', async () => {
    expect(await ticketForGrant(delegated())).toEqual({ ok: false, reason: 'delegated-token' })
  })

  test('a personal delegation names no organization, so the Solus API admits nothing with it', async () => {
    // WHY: the owner's personal delegation is for their account reads; organization records need an organization delegation.
    const personal: DelegatedAccessTokenClaims = {
      iss: 'https://app.example.test', aud: ['urn:solus:api', 'urn:solus:account'], sub: 'alice', client_id: 'host_h1',
      jti: crypto.randomUUID(), iat: now(), exp: now() + 300, act: { sub: 'host_h1', host_id: 'h1' }, grant_id: 'grant_1', access: 'owner',
    }
    expect(ticketForDelegatedMember(personal)).toEqual({ ok: false, reason: 'member-required' })
    expect(await ticketForGrant(personal, { workspace: true })).toEqual({ ok: false, reason: 'member-required' })
  })
})

describe('the delegations a connection makes', () => {
  // WHY: ADR 0001 §2.2 rule 6 — a host acts for a person only through a delegation made
  // from a token their client presented: `personal` for the owner, and the organization
  // the connection works in.
  test("the owner's connection makes a personal delegation, and the named organization's too", () => {
    expect(delegationScopesFor(clientToken({ access: 'owner' }), undefined)).toEqual(['personal'])
    expect(delegationScopesFor(clientToken({ access: 'owner' }), 'org_a')).toEqual(['personal', { organizationId: 'org_a' }])
  })

  test("a member's connection makes the delegation of the organization it named, and never a personal one", () => {
    expect(delegationScopesFor(member(), 'org_b')).toEqual([{ organizationId: 'org_b' }])
    expect(delegationScopesFor(member(), 'org_c')).toEqual([])
    expect(delegationScopesFor(member(), undefined)).toEqual([])
  })
})

describe('renewal of an open socket', () => {
  const owner: Principal = { kind: 'remote-owner', userId: 'alice', deviceId: 'grant_1', expiresAt: 1, deviceLabel: 'Solus cloud' }
  const memberPrincipal: Principal = {
    kind: 'org-member', userId: 'alice', organizationId: 'org_a', organizationRole: 'member', teamIds: ['t1'], hostKind: 'personal',
    displayName: 'Alice', deviceId: 'grant_1', expiresAt: 1, deviceLabel: 'Solus cloud',
  }

  test("the same person's next token moves the end of the socket", () => {
    const next = clientToken({ access: 'owner' })
    expect(renewalExpiry(owner, next)).toBe(next.exp * 1000)
    const listed = member()
    expect(renewalExpiry(memberPrincipal, listed)).toBe(listed.exp * 1000)
  })

  test("another person's token, a token in another standing, or one that no longer lists the organization does not", () => {
    // WHY: a renewal continues one admission; anything that changes who or where is a new connection.
    expect(renewalExpiry(owner, clientToken({ access: 'owner', sub: 'mallory' }))).toBeNull()
    expect(renewalExpiry(owner, member())).toBeNull()
    expect(renewalExpiry(memberPrincipal, member({ organizations: [{ id: 'org_b', role: 'owner', teamIds: [] }] }))).toBeNull()
    expect(renewalExpiry(memberPrincipal, member({ organizations: [{ id: 'org_a', role: 'owner', teamIds: ['t1'] }] }))).toBeNull()
    expect(renewalExpiry(memberPrincipal, delegated())).toBeNull()
  })
})
