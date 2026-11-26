/** An ACP agent in memory, and a backend that runs it, for the ACP backend tests. */
import { afterAll } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { AcpBackend } from '@solus/server/execution/agents/acp/acp-backend'
import type { AcpAgent } from '@solus/server/execution/agents/acp/acp-agent'
import { AcpRequestError } from '@solus/server/execution/agents/acp/acp-connection'

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type Message = { id?: number | string; method?: string; params?: Json; result?: Json; error?: Json }

const directories: string[] = []
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })
export function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-acp-test-'))
  directories.push(directory)
  return directory
}

/**
 * An ACP agent in memory. A test gives it a handler for each request method;
 * the handler can send updates and requests to the client before it answers.
 */
export class FakeAgent {
  readonly received: Message[] = []
  readonly answers = new Map<number | string, Json | undefined>()
  private nextId = 1000
  private readonly waiting = new Map<number | string, (result: Json | undefined) => void>()
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  constructor(readonly handlers: Partial<Record<string, (params: Json | undefined, agent: FakeAgent) => Promise<Json> | Json>>) {
    let buffer = ''
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        void this.onMessage(JSON.parse(line) as Message)
      }
    })
  }

  methods(): string[] {
    return this.received.filter((message) => message.method).map((message) => message.method!)
  }

  update(sessionId: string, update: Json): void {
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  }

  /** A request to the client; resolves with the client's answer. */
  request(method: string, params: Json): Promise<Json | undefined> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private send(message: Json): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  private async onMessage(message: Message): Promise<void> {
    this.received.push(message)
    if (message.method === undefined && message.id !== undefined) {
      this.answers.set(message.id, message.result ?? message.error)
      this.waiting.get(message.id)?.(message.result ?? (message.error as Json))
      this.waiting.delete(message.id)
      return
    }
    if (message.id === undefined || !message.method) return
    const handler = this.handlers[message.method]
    if (!handler) {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    try {
      this.send({ jsonrpc: '2.0', id: message.id, result: await handler(message.params, this) })
    } catch (error) {
      const code = error instanceof AcpRequestError ? error.code : -32603
      this.send({ jsonrpc: '2.0', id: message.id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

export class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly pid = undefined
  constructor(readonly agent: FakeAgent) { super() }
  get stdin() { return this.agent.stdin }
  get stdout() { return this.agent.stdout }
  get stderr() { return this.agent.stderr }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.signalCode = signal
    this.agent.stdout.end()
    this.emit('exit', null, signal)
    return true
  }
}

export const INITIALIZE: Json = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } },
  authMethods: [{ id: 'oauth-personal' }],
}

export const testAgent: AcpAgent = {
  id: 'antigravity',
  label: 'Antigravity',
  signInMessage: 'Sign in to Antigravity.',
  mcpServerName: 'solus',
  nameTool: () => null,
  isSignInRequired: (error) => error instanceof AcpRequestError && error.code === -32000,
  isQuestion: (toolCallId) => toolCallId.startsWith('interaction_'),
  sessionMeta: () => undefined,
  steersWithPrompt: (initialize) => initialize.agentInfo?.version === 'steers',
  listCommands: () => ({ global: [], project: [] }),
  launch: () => ({ file: 'agy', args: ['acp'], env: {}, connectionKey: 'profile', authMethod: 'oauth-personal', tempRoot: null }),
}

export function setup(handlers: FakeAgent['handlers'], options: { agents?: FakeAgent[]; agent?: Partial<AcpAgent> } = {}) {
  const agents = options.agents ?? []
  const spawns: NodeJS.ProcessEnv[] = []
  const indexed: Array<{ threadId: string; messages: SessionLoadMessage[] }> = []
  const backend = new AcpBackend({
    agent: { ...testAgent, ...options.agent },
    historyDirectory: temporaryDirectory(),
    indexMessages: (threadId, messages) => indexed.push({ threadId, messages }),
    spawnAgent: (_file, _args, spawnOptions) => {
      spawns.push(spawnOptions.env)
      const agent = new FakeAgent({
        initialize: () => INITIALIZE,
        authenticate: () => ({}),
        'session/new': () => ({ sessionId: 'thread-1', configOptions: [] }),
        ...handlers,
      })
      agents.push(agent)
      return new FakeChild(agent) as unknown as ChildProcess
    },
  })
  const events: NormalizedEvent[] = []
  const exits: Array<{ code: number | null; signal: string | null }> = []
  backend.on('normalized', (_sessionId: string | null, event: NormalizedEvent) => events.push(event))
  backend.on('exit', (_sessionId: string | null, code: number | null, signal: string | null) => exits.push({ code, signal }))
  const errors: Error[] = []
  backend.on('error', (_sessionId: string | null, error: Error) => errors.push(error))
  return { backend, events, exits, agents, errors, spawns, indexed }
}

export function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    provider: 'antigravity',
    organizationId: 'local',
    prompt: 'Fix the bug',
    cwd: '/tmp',
    tools: [],
    permissionMode: 'supervised',
    persistence: 'session',
    service: 'session',
    ...overrides,
  } as AgentRunRequest
}

export async function settle(promise: Promise<void>): Promise<void> {
  await promise.catch(() => {})
}
