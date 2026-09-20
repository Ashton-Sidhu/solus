import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'
import type { Principal } from '@solus/server/server/principal'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { getDatabase } = await import('@solus/server/db/database')
const { ShareManager } = await import('@solus/server/sharing/share-manager')
const { SharedPromptRelay } = await import('@solus/server/sharing/shared-prompt')
const { upsertSessionRecord } = await import('@solus/server/sessions/session-records')
const { ticketForGrant } = await import('@solus/server/server/http')

let dataDir: string
const oldDataDir = process.env.SOLUS_DATA_DIR
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'solus-p4-')); process.env.SOLUS_DATA_DIR = dataDir })
afterEach(async () => { await resetTestDatabase(); rmSync(dataDir, { recursive: true, force: true }); if (oldDataDir === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = oldDataDir })
const alice: Extract<Principal, { kind: 'org-member' }> = { kind: 'org-member', hostKind: 'cloud', organizationId: 'org1', organizationRole: 'owner', userId: 'alice', teamIds: [], displayName: 'Alice', deviceId: 'alice', deviceLabel: 'Cloud', expiresAt: Date.now() + 60_000 }
const runner: Extract<Principal, { kind: 'runner' }> = { kind: 'runner', organizationId: 'org1', hostId: 'runner1', deviceId: 'runner1', deviceLabel: 'Runner', expiresAt: Date.now() + 60_000 }
const resource = { kind: 'session', id: 'session1' } as const
async function fixture() {
  const shares = new ShareManager({ db: getDatabase() })
  await shares.claimOwner(resource, alice)
  const link = (await shares.setLink({ resource, role: 'editor' }, alice))!
  const resolved = (await shares.resolveLinkSecret(link.secret))!
  const guest: Extract<Principal, { kind: 'guest' }> = { kind: 'guest', organizationId: resolved.organizationId, guestId: 'maya', displayName: 'Maya', deviceId: 'maya', deviceLabel: 'Guest', share: resolved, expiresAt: Date.now() + 60_000 }
  await upsertSessionRecord('org1', { sessionId: resource.id, provider: 'claude-code', projectPath: '/fixture', lastActivityAt: Date.now(), runnerHostId: runner.hostId })
  return { shares, guest, relay: new SharedPromptRelay(shares), link }
}

test('guest access follows the resolved organization, cannot reach other records, and follows revocation', async () => {
  const { shares, guest } = await fixture()
  expect(await shares.roleFor(guest, resource)).toBe('editor')
  expect(await shares.roleFor({ ...guest, organizationId: 'org2' }, resource)).toBe('none')
  expect(await shares.roleFor(guest, { kind: 'session', id: 'other' })).toBe('none')
  await shares.setLink({ resource, role: 'viewer' }, alice)
  expect(await shares.roleFor(guest, resource)).toBe('viewer')
  await shares.setLink({ resource, role: null }, alice)
  expect(await shares.roleFor(guest, resource)).toBe('none')
})

test('a stopped runner gets no accepted prompt or retained work', async () => {
  const { guest, relay } = await fixture()
  expect(await relay.available(guest, resource.id)).toBe(false)
  await expect(relay.prompt(guest, { sessionId: resource.id, text: 'hello' })).rejects.toThrow('offline')
  expect((await relay.poll(runner)).commands).toEqual([])
})

test('only the selected runner receives the prompt; its receipt uses the sharer seat and never dispatches twice', async () => {
  const { guest, relay } = await fixture()
  await relay.poll(runner)
  const pending = relay.prompt(guest, { sessionId: resource.id, text: 'hello' })
  let commands = (await relay.poll(runner)).commands
  for (const deadline = Date.now() + 5_000; !commands.length && Date.now() < deadline;) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    commands = (await relay.poll(runner)).commands
  }
  expect(commands).toHaveLength(1)
  const command = commands[0]!
  expect(command.actor).toEqual({ userId: 'guest:maya', seatUserId: 'alice', displayName: 'Maya' })
  expect((await relay.poll(runner)).commands).toEqual([])
  expect(relay.result({ ...runner, organizationId: 'org2' }, { hostId: runner.hostId, requestId: command.requestId, error: null }).ok).toBe(false)
  expect(relay.result(runner, { hostId: runner.hostId, requestId: command.requestId, error: null }).ok).toBe(true)
  expect(await pending).toEqual({ accepted: true })
})

test('a viewer cannot submit and a host refuses guest grants before looking up the secret', async () => {
  const { shares, guest, relay, link } = await fixture()
  await shares.setLink({ resource, role: 'viewer' }, alice)
  await relay.poll(runner)
  await expect(relay.prompt(guest, { sessionId: resource.id, text: 'no' })).rejects.toThrow('not shared')
  const now = Math.floor(Date.now() / 1000)
  let lookedUp = false
  const result = await ticketForGrant({ iss: 'https://cloud.test', aud: 'runner1', sub: 'guest:maya', deviceId: 'maya', access: 'guest', hostKind: 'personal', jti: 'j', iat: now, exp: now + 60 }, { shareSecret: link.secret }, async () => { lookedUp = true; return { ...guest.share, organizationId: 'org1' } }, { workspace: false })
  expect(result).toEqual({ ok: false, reason: 'member-required' })
  expect(lookedUp).toBe(false)
})


test('a caller-chosen work id cannot replace an existing work in any organization', async () => {
  const { createWork, loadWork } = await import('@solus/server/folio/works')
  await createWork('org1', 'Original', 'doc', 'kept', '', undefined, 'claude-code', '~', 'stable-id')
  await expect(createWork('org2', 'Other', 'doc', 'wrong', '', undefined, 'claude-code', '~', 'stable-id')).rejects.toThrow()
  await expect(createWork('org1', 'Retry', 'doc', 'wrong', '', undefined, 'claude-code', '~', 'stable-id')).rejects.toThrow()
  expect((await loadWork('org1', 'stable-id'))?.content).toBe('kept')
  expect(await loadWork('org2', 'stable-id')).toBeNull()
})

test.skipIf(process.env.SOLUS_DB === 'postgres')('a cloud push preserves comments and the previous version, and keeps edits made during the push', async () => {
  const { createWork, agentSaveWork, saveWork, loadWork, exportWorkForCloud, importWorkFromHost, removePushedWork } = await import('@solus/server/folio/works')
  const { applyWorkComment, loadWorkAnnotations } = await import('@solus/server/folio/work-annotations')
  await createWork('local', 'A document', 'doc', 'first', '', undefined, 'claude-code', '~', 'push-work')
  await agentSaveWork('local', 'push-work', { content: 'second' })
  await applyWorkComment('local', 'push-work', { kind: 'add', comment: { id: 'comment1', selectedText: 'second', comment: 'Keep this' } }, { person: null, canModerate: true, now: 100 })
  const transfer = await exportWorkForCloud('local', 'push-work')
  expect(transfer.previous?.content).toBe('first')
  // Another database represents the workspace service, just as the Lab does.
  await resetTestDatabase()
  const sourceDir = process.env.SOLUS_DATA_DIR!
  const destinationDir = mkdtempSync(join(tmpdir(), 'solus-p4-destination-'))
  process.env.SOLUS_DATA_DIR = destinationDir
  try {
    await importWorkFromHost('org1', transfer)
    expect((await loadWorkAnnotations('org1', 'push-work'))?.comments[0]?.comment).toBe('Keep this')
    expect((await exportWorkForCloud('org1', 'push-work')).fingerprint).toBe(transfer.fingerprint)
    await importWorkFromHost('org1', transfer)
  } finally { await resetTestDatabase(); process.env.SOLUS_DATA_DIR = sourceDir; rmSync(destinationDir, { recursive: true, force: true }) }
  await saveWork('local', 'push-work', { content: 'new edit' })
  await expect(removePushedWork('local', 'push-work', transfer.fingerprint)).rejects.toThrow('local copy was kept')
  expect((await loadWork('local', 'push-work'))?.content).toBe('new edit')
})


test('an authenticated link visitor uses the verified account identity, never a typed name as a seat id', async () => {
  const { shares, link } = await fixture()
  const now = Math.floor(Date.now() / 1000)
  const outcome = await ticketForGrant({ iss: 'https://cloud.test', aud: 'solus-workspace', sub: 'user:bob', deviceId: 'account-session', access: 'guest', hostKind: 'cloud', displayName: 'Bob', jti: 'j', iat: now, exp: now + 60 }, { shareSecret: link.secret }, (secret) => shares.resolveLinkSecret(secret), { workspace: true })
  if (!outcome.ok) throw new Error('Expected a resource ticket')
  const { consumeWsTicket } = await import('@solus/server/server/auth')
  const { principalFor } = await import('@solus/server/server/principal')
  const ticket = consumeWsTicket(outcome.ticket)!
  const principal = principalFor({ kind: 'ticket', ticket })
  expect(principal.kind === 'guest' && principal.accountUserId).toBe('bob')
  expect(principal.deviceId).toBe('account-session')
  const relay = new SharedPromptRelay(shares)
  await relay.poll(runner)
  const pending = relay.prompt(principal, { sessionId: resource.id, text: 'my seat' })
  let commands = (await relay.poll(runner)).commands
  for (const deadline = Date.now() + 5_000; !commands.length && Date.now() < deadline;) { await new Promise<void>((resolve) => setImmediate(resolve)); commands = (await relay.poll(runner)).commands }
  expect(commands[0]?.actor).toEqual({ userId: 'bob', seatUserId: 'bob', displayName: 'Bob' })
  relay.result(runner, { hostId: runner.hostId, requestId: commands[0]!.requestId, error: null })
  await pending
})
