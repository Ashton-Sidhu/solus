import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * become_lead lets a session's own agent make it a lead when the work divides
 * into independent parts, so Meta mode does not depend on a choice the person
 * made before the first message (docs/plans/lead-session.md).
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

let dataDir: string
let tool: typeof import('@solus/server/execution/agents/tools/become-lead-tool')
let leads: typeof import('@solus/server/data/sessions/lead-sessions')
let settings: typeof import('@solus/server/execution/sessions/session-settings')
let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')

const PROJECT = '/Users/me/projects/solus'
const WORKER = 's-worker'
const INDEPENDENT = 's-independent'

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-become-lead-'))
  process.env.SOLUS_DATA_DIR = dataDir
  await resetTestDatabase()
  tool = await import('@solus/server/execution/agents/tools/become-lead-tool')
  leads = await import('@solus/server/data/sessions/lead-sessions')
  settings = await import('@solus/server/execution/sessions/session-settings')
  sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
  const delegation = { parentSessionId: 's-parent', rootSessionId: 's-parent', messageId: 'm-1', depth: 1, createdAt: 1 }
  sessionTools.setSessionController({
    getSessionInfo: async (sessionId: string) => {
      if (sessionId === WORKER) return { sessionId, delegation: { ...delegation, intent: 'delegate' } }
      if (sessionId === INDEPENDENT) return { sessionId, delegation: { ...delegation, intent: 'fire_and_forget' } }
      return { sessionId }
    },
  } as never)
})

beforeEach(() => leads.resetLeadSessionCache())

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('become_lead', () => {
  test('marks the session a lead and returns the lead contract for the turn in progress', async () => {
    // WHY: the system prompt of the running turn cannot change, so the result
    // is the only place the agent can read the contract before it starts workers.
    const result = await tool.becomeLead('s-promoted', PROJECT)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('This session is now a lead.')
    expect(result.text).toContain('Lead contract:')
    expect(await leads.isLeadSession('s-promoted')).toBe(true)
  })

  test("the contract in the result carries the person's lead settings", async () => {
    // WHY: the workers start in this same turn, so the default worker model
    // and the person's lead instructions must apply to it, not only to later runs.
    settings.recordSessionSettings('s-routed', {
      organizationId: 'local',
      preferences: {
        ...DEFAULT_EXECUTION_PREFERENCES,
        leadInstructions: 'Send frontend work to Claude Opus.',
        workerModel: { provider: 'codex', model: 'gpt-6', reasoningEffort: 'high' },
      },
    })
    const result = await tool.becomeLead('s-routed', PROJECT)
    expect(result.text).toContain("agent_provider 'codex', model_id 'gpt-6'")
    expect(result.text).toContain('Send frontend work to Claude Opus.')
  })

  test('clients hear the change once, and a repeat call changes nothing', async () => {
    // WHY: the session row shows the Meta mode mark as soon as the session is
    // a lead. A second call must not announce it again.
    const heard: string[] = []
    const stop = leads.onSessionBecameLead((sessionId) => { heard.push(sessionId) })
    try {
      await tool.becomeLead('s-once', PROJECT)
      const again = await tool.becomeLead('s-once', PROJECT)
      expect(again.ok).toBe(true)
      expect(again.text).toContain('This session is a lead already.')
      expect(again.text).toContain('Lead contract:')
      expect(heard).toEqual(['s-once'])
    } finally { stop() }
  })

  test('only self-promotion announces an agent transition, and waits for its history row', async () => {
    const heard: Array<{ sessionId: string; source?: 'agent' }> = []
    const stop = leads.onSessionBecameLead(async (sessionId, source) => {
      await Promise.resolve()
      heard.push({ sessionId, source })
    })
    try {
      await Promise.all([tool.becomeLead('s-divider', PROJECT), tool.becomeLead('s-divider', PROJECT)])
      expect(heard).toEqual([{ sessionId: 's-divider', source: 'agent' }])
      await tool.becomeLead('s-divider', PROJECT)
      await tool.becomeLead(WORKER, PROJECT)
      expect(heard).toHaveLength(1)
      await leads.markSessionLead('s-composer')
      expect(heard.at(-1)).toEqual({ sessionId: 's-composer', source: undefined })
    } finally { stop() }
  })

  test('a worker cannot become a lead', async () => {
    // WHY: a worker that became a lead would start its own workers, and one
    // request would grow into a tree of sessions the person did not ask for.
    const result = await tool.becomeLead(WORKER, PROJECT)
    expect(result.ok).toBe(false)
    expect(await leads.isLeadSession(WORKER)).toBe(false)
  })

  test('an independent session that another session started can become a lead', async () => {
    // WHY: an independent session is a conversation of its own, not a worker.
    expect((await tool.becomeLead(INDEPENDENT, PROJECT)).ok).toBe(true)
    expect(await leads.isLeadSession(INDEPENDENT)).toBe(true)
  })

  test('a chat cannot become a lead', async () => {
    // WHY: a chat has no project, and no client offers Meta mode for one.
    const result = await tool.becomeLead('s-chat', '/Users/me/.solus/solus-chats/chat-1')
    expect(result.ok).toBe(false)
    expect(await leads.isLeadSession('s-chat')).toBe(false)
  })

  test('a session with no id yet is refused', async () => {
    expect((await tool.becomeLead(undefined, PROJECT)).ok).toBe(false)
  })
})
