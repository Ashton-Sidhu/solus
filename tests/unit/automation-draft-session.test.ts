import { describe, expect, test } from 'bun:test'
import { registerSessionHandlers } from '../../src/main/server/handlers/session-handlers'
import { automationDraftSessionRequest } from '../../src/renderer/contexts/automations/automation-draft-session'

describe('automation draft sessions', () => {
  test('builds a low-reasoning headless request from the configured provider defaults', () => {
    expect(automationDraftSessionRequest(
      'Create a weekly cleanup automation',
      '/repo',
      'codex',
      {
        modelId: 'gpt-test',
        reasoningEffort: 'high',
        contextWindow: 200_000,
        fastMode: true,
      },
    )).toEqual({
      prompt: 'Create a weekly cleanup automation',
      cwd: '/repo',
      provider: 'codex',
      modelId: 'gpt-test',
      reasoningEffort: 'low',
      contextWindow: 200_000,
      // The saved automation is the artifact of this session; a task row for
      // "set up an automation" is noise on the board.
      skipTaskCreation: true,
    })
  })

  test('routes the request through session creation without creating a tab', async () => {
    const handlers = new Map<string, (args: unknown[]) => unknown>()
    let createTabCalls = 0
    const controlPlane = {
      createSession: async () => ({ agentSessionId: 'draft-session' }),
      createTab: () => {
        createTabCalls++
        return 'unexpected-tab'
      },
    }
    registerSessionHandlers(
      {
        register: (name: string, handler: (args: unknown[]) => unknown) => {
          handlers.set(name, handler)
        },
      } as never,
      {
        controlPlane,
        agentIdFromContext: () => 'codex',
      } as never,
    )

    const createHeadlessSession = handlers.get('createHeadlessSession')
    expect(createHeadlessSession).toBeDefined()
    await expect(createHeadlessSession!([{
      prompt: 'Create an automation',
      provider: 'codex',
      modelId: null,
      reasoningEffort: 'low',
      contextWindow: null,
      cwd: '/repo',
    }])).resolves.toEqual({ agentSessionId: 'draft-session' })
    expect(createTabCalls).toBe(0)
  })
})
