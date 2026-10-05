import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { CodexRpcError } from '@solus/server/execution/agents/codex/codex-agent'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
})

describe('Codex backend configuration', () => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork'] as const) {
    test(`preserves orchestration guidance outside mode text on ${method}`, async () => {
      const backend = new CodexBackend()
      type CapturedParams = {
        developerInstructions?: string | null
        collaborationMode?: { settings: { developer_instructions: string | null } }
      }
      const requests: Array<{ method: string; params: CapturedParams }> = []
      const { promise: turnStarted, resolve: markTurnStarted } = Promise.withResolvers<void>()
      Reflect.set(backend, 'client', {
        request: async (requestMethod: string, params: CapturedParams) => {
          requests.push({ method: requestMethod, params })
          if (requestMethod === method) return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
          if (requestMethod === 'turn/start') {
            markTurnStarted()
            return { turn: { id: 'turn-1' } }
          }
          throw new Error(`Unexpected method: ${requestMethod}`)
        },
      })
      const conversation: AgentRunRequest['conversation'] = method === 'thread/fork'
        ? { kind: 'fork', sourceThreadId: 'source-thread' }
        : method === 'thread/resume' ? { kind: 'resume', threadId: 'thread-1' } : { kind: 'start' }
      const tools: AgentTool[] = ['start_session', 'list_agent_targets', 'browser_status', 'link'].map((name) => ({
        name, description: name, inputFields: {}, requiresApproval: false,
        execute: async () => ({ ok: true, text: '' }),
      }))
      backend.startRun({
        provider: 'codex', prompt: 'Review it', cwd: '/tmp/project', tools,
        model: 'gpt-5.6-sol', reasoningEffort: 'high', permissionMode: 'full-access',
        persistence: 'ephemeral', service: 'sessions', conversation,
        systemPrompt: 'User extra instructions:\nStay concise.',
      })
      await turnStarted
      const developer = requests.find((request) => request.method === method)?.params.developerInstructions
      expect(developer).toStartWith('User extra instructions:\nStay concise.')
      expect(developer).toContain('## Solus orchestration')
      expect(developer).toContain('call list_agent_targets')
      expect(developer).toContain('## Solus collaborative browser')
      expect(developer).toContain('## Pull request linking')
      expect(requests.find((request) => request.method === 'turn/start')?.params.collaborationMode?.settings.developer_instructions).not.toContain('Solus')
    })
  }

  test('removes tool guidance when Codex rejects dynamic tools', async () => {
    const backend = new CodexBackend()
    const starts: Array<{ developerInstructions?: string | null }> = []
    const { promise: turnStarted, resolve: markTurnStarted } = Promise.withResolvers<void>()
    Reflect.set(backend, 'client', {
      request: async (method: string, params: { developerInstructions?: string | null }) => {
        if (method === 'thread/start') {
          starts.push(params)
          if (starts.length === 1) throw new CodexRpcError('Dynamic tools unavailable', -32602)
          return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
        }
        if (method === 'turn/start') {
          markTurnStarted()
          return { turn: { id: 'turn-1' } }
        }
        throw new Error(`Unexpected method: ${method}`)
      },
    })
    backend.startRun({
      provider: 'codex', prompt: 'Build it', cwd: '/tmp/project',
      tools: [{ name: 'start_session', description: 'Start', inputFields: {}, requiresApproval: false, execute: async () => ({ ok: true, text: '' }) }],
      model: 'gpt-5.6-sol', permissionMode: 'full-access', persistence: 'ephemeral', service: 'sessions',
      systemPrompt: 'User extra instructions:\nStay concise.',
    })
    await turnStarted
    expect(starts[0]?.developerInstructions).toContain('## Solus orchestration')
    expect(starts[1]?.developerInstructions).toContain('Stay concise.')
    expect(starts[1]?.developerInstructions).toContain('<runtime_info>')
    expect(starts[1]?.developerInstructions).not.toContain('## Solus orchestration')
  })

  test('sets the fast service tier on both the thread and the turn', async () => {
    // WHY: setting only the initial thread does not update resumed sessions,
    // while setting only the turn leaves new-thread defaults inconsistent.
    const backend = new CodexBackend()
    const requests: Array<{ method: string; params: { serviceTier?: string | null } }> = []
    let markTurnStarted!: () => void
    const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve })
    const client = {
      request: async (method: string, params: { serviceTier?: string | null }) => {
        requests.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
        }
        if (method === 'turn/start') {
          markTurnStarted()
          return { turn: { id: 'turn-1' } }
        }
        throw new Error(`Unexpected method: ${method}`)
      },
    }
    Reflect.set(backend, 'client', client)

    backend.startRun({
      provider: 'codex',
      prompt: 'Build it',
      cwd: '/tmp/project',
      tools: [],
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      fastMode: true,
      permissionMode: 'full-access',
      persistence: 'ephemeral',
      service: 'sessions',
    })
    await turnStarted

    expect(requests.find((request) => request.method === 'thread/start')?.params.serviceTier).toBe('fast')
    expect(requests.find((request) => request.method === 'turn/start')?.params.serviceTier).toBe('fast')
  })

  test('keeps the Codex base native and separates host guidance from collaboration instructions', async () => {
    // WHY: baseInstructions replaces Codex's maintained harness prompt. Solus
    // user/host instructions and provider-specific mode behavior belong in the two
    // separate developer instruction slots.
    type CapturedParams = {
      baseInstructions?: string | null
      developerInstructions?: string | null
      collaborationMode?: {
        mode: 'default' | 'plan'
        settings: { developer_instructions: string | null }
      }
    }
    const backend = new CodexBackend()
    const requests: Array<{ method: string; params: CapturedParams }> = []
    let markTurnStarted!: () => void
    const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve })
    const client = {
      request: async (method: string, params: CapturedParams) => {
        requests.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
        }
        if (method === 'turn/start') {
          markTurnStarted()
          return { turn: { id: 'turn-1' } }
        }
        throw new Error(`Unexpected method: ${method}`)
      },
    }
    Reflect.set(backend, 'client', client)

    backend.startRun({
      provider: 'codex',
      prompt: 'Plan it',
      cwd: '/tmp/project',
      tools: [],
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      permissionMode: 'plan',
      persistence: 'ephemeral',
      service: 'sessions',
      systemPrompt: 'User extra instructions:\nStay concise.',
    })
    await turnStarted

    const threadParams = requests.find((request) => request.method === 'thread/start')?.params
    const turnParams = requests.find((request) => request.method === 'turn/start')?.params
    expect(threadParams).not.toHaveProperty('baseInstructions')
    expect(threadParams?.developerInstructions).toStartWith('User extra instructions:\nStay concise.\n\n<runtime_info>')
    expect(threadParams?.developerInstructions).toContain('through the Codex harness')
    expect(turnParams?.collaborationMode?.settings.developer_instructions).not.toContain('<runtime_info>')
    expect(turnParams?.collaborationMode?.mode).toBe('plan')
    expect(turnParams?.collaborationMode?.settings.developer_instructions).toContain(
      '# Plan Mode (Conversational)',
    )
    expect(turnParams?.collaborationMode?.settings.developer_instructions).not.toContain(
      'Stay concise.',
    )
    expect(turnParams?.collaborationMode?.settings.developer_instructions).not.toContain(
      '## Solus collaborative browser',
    )
  })

  test('sends host instructions even without user instructions', async () => {
    type CapturedParams = {
      developerInstructions?: string | null
      collaborationMode?: {
        mode: 'default' | 'plan'
        settings: { developer_instructions: string | null }
      }
    }
    const backend = new CodexBackend()
    const requests: Array<{ method: string; params: CapturedParams }> = []
    let markTurnStarted!: () => void
    const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve })
    const client = {
      request: async (method: string, params: CapturedParams) => {
        requests.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
        }
        if (method === 'turn/start') {
          markTurnStarted()
          return { turn: { id: 'turn-1' } }
        }
        throw new Error(`Unexpected method: ${method}`)
      },
    }
    Reflect.set(backend, 'client', client)

    backend.startRun({
      provider: 'codex',
      prompt: 'Build it',
      cwd: '/tmp/project',
      tools: [],
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      permissionMode: 'full-access',
      persistence: 'ephemeral',
      service: 'sessions',
      systemPrompt: '   ',
    })
    await turnStarted

    const threadParams = requests.find((request) => request.method === 'thread/start')?.params
    const turnParams = requests.find((request) => request.method === 'turn/start')?.params
    expect(threadParams?.developerInstructions).toStartWith('<runtime_info>')
    expect(turnParams?.collaborationMode?.mode).toBe('default')
    expect(turnParams?.collaborationMode?.settings.developer_instructions).toContain(
      '# Collaboration Mode: Default',
    )
  })
})
