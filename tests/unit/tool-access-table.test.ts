import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { ResourceRole } from '@solus/contracts/sharing'
import type { Actor } from '@solus/server/admission/actor'
import type { AccessResource } from '@solus/server/admission/access'
import type { Principal } from '@solus/server/admission/principal'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: an agent's tool call is a second way into the host. A person reaches
// through their agent only what they reach from a client (plans/035 §5), so a
// tool call is decided by the same rule as the RPC method for the same action.

let solusToolbox: typeof import('@solus/server/execution/agents/tools/solus-toolbox')['solusToolbox']
let credentialScopedAgentTools: typeof import('@solus/server/execution/sessions/run-lifecycle')['credentialScopedAgentTools']
let toolAccessOf: typeof import('@solus/server/execution/agents/tools/tool-access')['toolAccessOf']
let toolAccessRefusal: typeof import('@solus/server/execution/agents/tools/tool-access')['toolAccessRefusal']
let withWorkspaceToolAuthority: typeof import('@solus/server/admission/workspace-tool-authority')['withWorkspaceToolAuthority']

/** The role each test gives a person on a record, by `<kind>:<id>`. */
const roles = new Map<string, ResourceRole>()

beforeAll(async () => {
  ;({ solusToolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox'))
  ;({ credentialScopedAgentTools } = await import('@solus/server/execution/sessions/run-lifecycle'))
  ;({ toolAccessOf, toolAccessRefusal } = await import('@solus/server/execution/agents/tools/tool-access'))
  const authority = await import('@solus/server/admission/workspace-tool-authority')
  withWorkspaceToolAuthority = authority.withWorkspaceToolAuthority
  authority.installToolAccess(async () => 'none', {
    standingFor: async (_principal: Principal, resource: AccessResource) => ({ role: roles.get(`${resource.kind}:${resource.id}`) ?? 'none' }),
  })
})

const member: Principal = { kind: 'org-member', userId: 'alice', organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Alice', deviceId: 'alice-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300_000 }
const admin: Principal = { ...member, userId: 'olga', organizationRole: 'owner', hostKind: 'cloud', displayName: 'Olga', deviceId: 'olga-device' }
const guest: Principal = {
  kind: 'guest', guestId: 'g1', displayName: 'Visitor', deviceId: 'g1', deviceLabel: 'Browser', expiresAt: Date.now() + 300_000,
  share: { resource: { kind: 'session', id: 'shared-session' }, role: 'editor', sharedByUserId: 'owner', linkSecretHash: 'hash' },
}
const actorOf = (principal: Principal): Actor => ({ principal, user: null })

function context(sessionId?: string): AgentToolContext {
  return { provider: 'claude-code', cwd: '/tmp', sessionId: () => sessionId, abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} }
}

/** A tool with a real tool's name whose body only says that it ran. */
function stand(name: string): AgentTool {
  return { name, description: name, inputFields: {}, requiresApproval: false, execute: async () => ({ ok: true, text: 'ran' }) }
}

/** Whether `principal`'s agent may make this call: true, or the refusal. */
async function may(principal: Principal, name: string, input: { [field: string]: string } = {}, sessionId?: string): Promise<true | string> {
  return await toolAccessRefusal(stand(name), input, sessionId, principal) ?? true
}

describe('every tool has an access rule', () => {
  test('each toolbox tool resolves to a rule', () => {
    const missing = Object.values(solusToolbox).flatMap((group) => Object.values(group)).filter((tool) => !toolAccessOf(tool)).map((tool) => tool.name)
    expect(missing).toEqual([])
  })

  test('a tool with no rule is refused', async () => {
    expect(await may(member, 'made_up_tool')).toBe('made_up_tool has no access rule.')
  })

  test("the run's tools refuse a call before the tool runs", async () => {
    let ran = false
    const tool: AgentTool = { ...stand('update_work'), execute: async () => { ran = true; return { ok: true, text: 'ran' } } }
    const [scoped] = credentialScopedAgentTools([tool], actorOf(member))
    const result = await scoped!.execute({ work_id: 'not-shared' }, context())
    expect(result.ok).toBe(false)
    expect(ran).toBe(false)
  })
})

describe('a tool call is decided as the RPC call for the same action', () => {
  test('a work the person cannot edit is not changed through their agent', async () => {
    roles.set('work:w1', 'viewer')
    expect(await may(member, 'update_work', { work_id: 'w1' })).not.toBe(true)
    expect(await may(member, 'read_work', { work_id: 'w1' })).toBe(true)
    roles.set('work:w1', 'editor')
    expect(await may(member, 'update_work', { work_id: 'w1' })).toBe(true)
  })

  test('publishing and pulling a work need edit on it', async () => {
    roles.set('work:w2', 'viewer')
    expect(await may(member, 'publish_work', { work_id: 'w2' })).not.toBe(true)
    expect(await may(member, 'pull_work_upstream', { work_id: 'w2' })).not.toBe(true)
  })

  test('replying to and resolving a comment need comment on its work or plan', async () => {
    roles.set('work:w3', 'viewer')
    expect(await may(member, 'reply_comment', { target_id: 'w3', comment_id: 'c' })).not.toBe(true)
    expect(await may(member, 'resolve_comment', { target_id: 'w3', comment_id: 'c' })).not.toBe(true)
    roles.set('work:w3', 'commenter')
    expect(await may(member, 'reply_comment', { target_id: 'w3', comment_id: 'c' })).toBe(true)
    // A plan id names its session: the session's role decides.
    roles.set('session:s9', 'viewer')
    expect(await may(member, 'resolve_comment', { target_id: 's9__plan1', comment_id: 'c' })).not.toBe(true)
  })

  test('a tool that acts on its own session needs the right on that session', async () => {
    roles.set('session:s1', 'viewer')
    expect(await may(member, 'move_checkout', {}, 's1')).not.toBe(true)
    roles.set('session:s1', 'editor')
    expect(await may(member, 'move_checkout', {}, 's1')).toBe(true)
  })

  test('a guest turn reaches its shared session, not the host', async () => {
    expect(await may(guest, 'list_works')).not.toBe(true)
    expect(await may(guest, 'browser_open')).not.toBe(true)
  })

  test('changing how the host is reached is refused to a member', async () => {
    expect(await may(member, 'add_host')).not.toBe(true)
  })
})

describe('update_config', () => {
  async function updateAs(principal: Principal, input: { host?: { analyticsEnabled: boolean }; deviceManager?: { enabled: boolean } }) {
    return withWorkspaceToolAuthority(principal, () => solusToolbox.config.update.execute(input, context()))
  }

  test("this machine's settings are an administrator's", async () => {
    const refused = await updateAs(member, { host: { analyticsEnabled: false } })
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('administrator')
    const devices = await updateAs(member, { deviceManager: { enabled: false } })
    expect(devices.ok).toBe(false)
    expect(devices.text).toContain('administrator')
  })

  test('an administrator passes the check', async () => {
    const result = await updateAs(admin, { host: { analyticsEnabled: false } })
    expect(result.text).not.toContain('administrator')
  })
})
