import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Principal } from '@solus/server/admission/principal'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const directory = mkdtempSync(join(tmpdir(), 'solus-automation-access-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = directory

// docs/plans/access-model.md §4 D4: an automation belongs to the person it runs
// for. A member sees and changes their own; a host administrator sees and changes
// all. The rule holds for the RPC list and for the agent tools a turn calls.

let store: typeof import('@solus/server/data/automations/automations-store')
let tools: typeof import('@solus/server/execution/agents/tools/automation-tools')
let authority: typeof import('@solus/server/admission/workspace-tool-authority')
let actors: typeof import('@solus/server/admission/actor')
let db: typeof import('@solus/server/db')

const member = (userId: string, organizationRole: 'owner' | 'member' = 'member'): Principal => ({
  kind: 'org-member', userId, organizationId: 'local', organizationRole, teamIds: [], hostKind: 'managed',
  displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})

beforeAll(async () => {
  store = await import('@solus/server/data/automations/automations-store')
  tools = await import('@solus/server/execution/agents/tools/automation-tools')
  authority = await import('@solus/server/admission/workspace-tool-authority')
  actors = await import('@solus/server/admission/actor')
  db = await import('@solus/server/db')
})
afterAll(() => {
  db.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(directory, { recursive: true, force: true })
})

const action = { prompt: 'Summarise the day.', agentProvider: 'codex' as const, modelId: null, reasoningEffort: 'medium' as const, cwd: directory }

describe('automation owners', () => {
  test('the person who makes an automation owns it; the host\'s own is the host user\'s', async () => {
    const bobs = await store.createAutomation('Bob\'s', action, actors.attributionOf(actors.actorFor(member('bob'))))
    const hosts = await store.createAutomation('Host\'s', action, { kind: 'system' })
    expect(store.automationHomeOf(bobs.id)?.ownerKey).toBe('bob')
    expect(store.automationHomeOf(hosts.id)?.ownerKey).toBe((await import('@solus/server/host/host-user')).hostUserKey())
    // An update never changes the owner.
    await store.updateAutomation(bobs.id, { name: 'Renamed' })
    expect(store.automationHomeOf(bobs.id)?.ownerKey).toBe('bob')
  })

  test('a member lists only their own; an administrator lists every one', async () => {
    const dan = await store.createAutomation('Dan\'s', action, actors.attributionOf(actors.actorFor(member('dan'))))
    const danSees = (await store.listAutomations(actors.actorFor(member('dan')))).map((automation) => automation.id)
    expect(danSees).toEqual([dan.id])
    const adminSees = await store.listAutomations(actors.actorFor(member('alice', 'owner')))
    expect(adminSees.map((automation) => automation.name).sort()).toEqual(['Dan\'s', 'Host\'s', 'Renamed'])
    // Each listed automation carries the reader's role, so a client offers what the gate allows (access-model.md §2.7).
    expect((await store.listAutomations(actors.actorFor(member('dan'))))[0]?.role).toBe('owner')
    expect(adminSees.find((automation) => automation.id === dan.id)?.role).toBe('editor')
    expect(store.withAutomationRole(actors.actorFor(member('erin')), dan).role).toBe('none')
  })

  test('a pause or edit keeps an automation in its place; only creation order sorts the list', async () => {
    // WHY: toggling a row must not move it under the pointer, or the next click hits a different automation.
    const fay = actors.actorFor(member('fay'))
    const older = await store.createAutomation('Older', action, actors.attributionOf(fay))
    await new Promise((resolve) => setTimeout(resolve, 2))
    const newer = await store.createAutomation('Newer', action, actors.attributionOf(fay))
    expect((await store.listAutomations(fay)).map((automation) => automation.id)).toEqual([newer.id, older.id])
    await new Promise((resolve) => setTimeout(resolve, 2))
    await store.updateAutomation(older.id, { enabled: false })
    expect((await store.listAutomations(fay)).map((automation) => automation.id)).toEqual([newer.id, older.id])
  })

  test('a turn\'s automation tools act as its person: another member\'s automation does not exist for them', async () => {
    // WHY: an agent tool is a door like an RPC; a member's agent must not reach what the member cannot.
    const bobs = (await store.listAutomations(actors.HOST_ACTOR)).find((automation) => automation.name === 'Renamed')!
    const asDan = <T>(run: () => Promise<T>) => authority.withWorkspaceToolAuthority(member('dan'), run)
    const listed = await asDan(() => tools.executeAutomationTool('list_automations', {}))
    expect(listed.text).not.toContain(bobs.id)
    for (const name of ['read_automation', 'update_automation', 'run_automation', 'list_automation_runs']) {
      const result = await asDan(() => tools.executeAutomationTool(name, { automation_id: bobs.id, name: 'x' }))
      expect({ name, ok: result.ok }).toEqual({ name, ok: false })
    }
    const deleted = await asDan(() => tools.executeAutomationTool('delete_automation', { automation_id: bobs.id }))
    expect(deleted.ok).toBe(false)
    expect(store.automationHomeOf(bobs.id)).not.toBeNull()
    // An administrator's turn reaches it.
    const asAdmin = await authority.withWorkspaceToolAuthority(member('alice', 'owner'), () => tools.executeAutomationTool('read_automation', { automation_id: bobs.id }))
    expect(asAdmin.ok).toBe(true)
  })
})
