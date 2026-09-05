import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/agents/codex/codex-backend'))
})

describe('Codex backend configuration', () => {
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
      permissionMode: 'auto',
      persistence: 'ephemeral',
      service: 'sessions',
    })
    await turnStarted

    expect(requests.find((request) => request.method === 'thread/start')?.params.serviceTier).toBe('fast')
    expect(requests.find((request) => request.method === 'turn/start')?.params.serviceTier).toBe('fast')
  })

  test('keeps the Codex base native and separates user and collaboration instructions', async () => {
    // WHY: baseInstructions replaces Codex's maintained harness prompt. Solus
    // user instructions and provider-specific mode behavior belong in the two
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
    expect(threadParams?.developerInstructions).toBe('User extra instructions:\nStay concise.')
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

  test('omits the developer override when Solus has no user instructions', async () => {
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
      permissionMode: 'auto',
      persistence: 'ephemeral',
      service: 'sessions',
      systemPrompt: '   ',
    })
    await turnStarted

    const threadParams = requests.find((request) => request.method === 'thread/start')?.params
    const turnParams = requests.find((request) => request.method === 'turn/start')?.params
    expect(threadParams).not.toHaveProperty('developerInstructions')
    expect(turnParams?.collaborationMode?.mode).toBe('default')
    expect(turnParams?.collaborationMode?.settings.developer_instructions).toContain(
      '# Collaboration Mode: Default',
    )
  })
})
