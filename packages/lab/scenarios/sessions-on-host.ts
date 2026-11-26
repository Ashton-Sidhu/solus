import { randomUUID } from 'node:crypto'
import type { IpcContext, SessionCtx, StatusBarCtx } from '@solus/contracts/types'
import { organizationPolicyTemplate } from '@solus/contracts/policy'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { LabClient } from '../src/client'
import { bootLabHost } from '../src/host'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectOk, scenario, type ScenarioContext } from '../src/scenario'
import { bootLabSolusApi } from '../src/solus-api'

/**
 * An organization does not save its sessions to Solus Cloud
 * (`sessions.limits.sessionCloudSync: false`, docs/session-cloud-copy.md). A
 * member runs a turn on a cloud machine that the organization runs. No row of
 * the conversation reaches the Solus API. The machine lists the session and
 * gives its conversation, so a client reads it from the machine.
 */

/** `__MOCK_CLOUD__`: the mock agent keeps a transcript on disk, as a real provider does, so the host has rows that it could send. */
const PROMPT = '__MOCK_CLOUD__ LAB-PROMPT-TEXT keep this on the host'

function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, gitContext: null, worktreeBaseBranch: null, contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: ORGANIZATION_ID }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the cloud sessions scenario relies on too.
  return { session, statusBar } as IpcContext
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    last = await read()
  }
  return last
}

async function transcriptOn(client: LabClient, sessionId: string): Promise<WireSessionLoadMessage[]> {
  return (await client.rpc('loadSessionPage', { sessionId, provider: 'claude-code', turnLimit: 100 })).messages
}

const shown = (rows: WireSessionLoadMessage[]) => JSON.stringify(rows.map((row) => ({ role: row.role, content: row.content.slice(0, 40) })))

/** The host reads its transcript once the events settle (2 s) and then delivers it: after this time a row that was sent is on the Solus API. */
const DELIVERY_WAIT_MS = 6_000

export default scenario('sessions on the host: an organization that does not save its sessions sends no conversation to the Solus API', async (ctx) => {
  const clients: LabClient[] = []
  const service = await bootLabSolusApi({ issuer: ctx.issuer, engine: 'sqlite' })
  const previousRoute = ctx.issuer.workspaceRoute
  ctx.issuer.setWorkspaceRoute(service.url)
  ctx.issuer.setOrganizationPolicy({ ...organizationPolicyTemplate('Lab'), sessions: { limits: { insights: { syncAll: true }, sessionCloudSync: false } } })
  const machine = await bootLabHost({ flavor: 'cloud', issuer: ctx.issuer, hostId: 'labsessionsonhost', operatedFor: ORGANIZATION_ID })
  try {
    ctx.step('a member runs a turn on a cloud machine of an organization that does not save its sessions')
    const member = new LabClient({ persona: personaForHost('alice', 'cloud'), hostUrl: machine.tunnelUrl, issuer: ctx.issuer, hostId: machine.hostId, hostKind: 'cloud' })
    clients.push(member)
    ctx.check('alice reaches the machine as a member', (await member.connect()).ok)
    await expectOk(ctx, 'alice connects her Claude seat', member.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-alice' }))
    const sessionId = randomUUID()
    await member.rpc('watchSession', { sessionId })
    await expectOk(ctx, 'alice sends the prompt', member.rpc('prompt', promptContext(ctx, sessionId), { prompt: PROMPT, clientPromptId: `${sessionId}-1` }))

    ctx.step('the machine lists the session and gives its conversation')
    const onHost = await until(() => transcriptOn(member, sessionId), (rows) => rows.some((row) => row.role === 'assistant' && row.content.trim().length > 0), 20_000)
    ctx.check('the machine gives the prompt', onHost.some((row) => row.role === 'user' && row.content.includes('LAB-PROMPT-TEXT')), shown(onHost))
    ctx.check('the machine gives the answer', onHost.some((row) => row.role === 'assistant' && row.content.trim().length > 0), shown(onHost))
    const listed = await member.records.sessionRecordList({ scope: 'all' })
    ctx.check('the machine lists the session', listed.records.some((record) => record.sessionId === sessionId), String(listed.records.length))

    ctx.step('no row of the conversation reaches the Solus API')
    const reader = new LabClient({ persona: personaForHost('alice', 'api'), hostUrl: service.url, issuer: ctx.issuer, hostId: SOLUS_API_AUDIENCE, hostKind: 'api' })
    clients.push(reader)
    ctx.check('alice reaches the Solus API', (await reader.connect()).ok)
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_WAIT_MS))
    const copy = await transcriptOn(reader, sessionId).catch(() => [])
    ctx.check('the Solus API has no row of the session', copy.length === 0, shown(copy))
  } finally {
    for (const client of clients) client.close()
    await machine.stop()
    ctx.issuer.setOrganizationPolicy(null)
    ctx.issuer.setWorkspaceRoute(previousRoute)
    await service.stop()
  }
}, { only: 'personal' })
