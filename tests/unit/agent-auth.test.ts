import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import type { AgentAuthFinishedEvent } from '@solus/contracts/agent-auth'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import type { ClaudeMcpAuthSession, McpAuthenticateResponse } from '@solus/server/execution/agents/claude/claude-mcp-auth'

const BOB: Seat = { kind: 'user', userId: { kind: 'account', accountId: 'bob' } }
const EVE: Seat = { kind: 'user', userId: { kind: 'account', accountId: 'eve' } }

// The flows reach the seat manager, which opens the host database module; bun has no node:sqlite.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let AgentAuthFlows: typeof import('@solus/server/execution/seats/agent-auth')['AgentAuthFlows']
let SeatManager: typeof import('@solus/server/execution/seats/seat-manager')['SeatManager']

beforeAll(async () => {
  ;({ AgentAuthFlows } = await import('@solus/server/execution/seats/agent-auth'))
  ;({ SeatManager } = await import('@solus/server/execution/seats/seat-manager'))
})

// docs/plans/agent-auth-commands.md: `/design-login` and `/mcp login` run on the
// host in the caller's own seat. The link goes out, the code or redirect address
// comes back, and the end reaches only that seat's clients.

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdinWrites: string[] = []
  stdin = { writable: true, write: (chunk: string) => { this.stdinWrites.push(chunk); return true } }
  pid = undefined
  kill(signal: NodeJS.Signals) { this.emit('close', null, signal); return true }
}

class FakeMcpSession implements ClaudeMcpAuthSession {
  closed = false
  submitted: string[] = []
  constructor(public current: McpServerStatus['status'] | null, private readonly response: McpAuthenticateResponse) {}
  async status(server: string) { return this.current ? { name: server, status: this.current } : null }
  async authenticate() { return this.response }
  async submitCallbackUrl(_server: string, url: string) { this.submitted.push(url) }
  async clearAuth() {}
  async close() { this.closed = true }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function harness(mcpSession?: FakeMcpSession) {
  const root = mkdtempSync(join(tmpdir(), 'agent-auth-'))
  roots.push(root)
  const db = new Database(':memory:') as unknown as DatabaseSync
  const seats = new SeatManager({ db, seatsRoot: join(root, 'seats'), hostClaudeDir: join(root, '.claude'), hostCodexHome: join(root, '.codex') })
  const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }> = []
  const finished: AgentAuthFinishedEvent[] = []
  const flows = new AgentAuthFlows({
    seats,
    mcpStatusPollMs: 1,
    openClaudeMcp: async () => {
      if (!mcpSession) throw new Error('no MCP session in this test')
      return mcpSession
    },
    spawnProcess: (command, args, options) => {
      const child = new FakeChild()
      spawned.push({ command, args, env: (options?.env ?? {}) as NodeJS.ProcessEnv, child })
      return child as unknown as ChildProcess
    },
  })
  flows.onFinished((event) => finished.push(event))
  return { seats, flows, spawned, finished }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('AgentAuthFlows: Claude Design', () => {
  test('runs in the member seat, outside any Claude Code session, and relays the JSON-lines sign-in', async () => {
    const { seats, flows, spawned, finished } = harness()
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    try {
      const started = flows.start(BOB, { kind: 'claude-design' })
      const [spawn] = spawned
      expect(spawn?.args).toEqual(['design-login', '--json'])
      // The credential must land where Bob's turns read it, and the CLI refuses a nested session.
      expect(spawn?.env.CLAUDE_CONFIG_DIR).toBe(seats.homeFor(BOB, 'claude-code'))
      expect(spawn?.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
      spawn!.child.stdout.emit('data', '{"event":"pages","url":"http://localhost:1/auto","manual_url":"https://claude.ai/manual","manual_first":false}\n')
      const result = await started
      // The manual page shows a code, which works from a browser on any device.
      expect(result).toMatchObject({ state: 'waiting', url: 'https://claude.ai/manual', input: 'code' })
      if (result.state !== 'waiting') throw new Error('expected a waiting flow')
      await flows.submit(BOB, result.flowId, ' abc#state ')
      expect(spawn!.child.stdinWrites).toEqual(['{"code":"abc#state"}\n'])
      spawn!.child.stdout.emit('data', '{"event":"done","ok":true}\n')
      expect(finished).toEqual([{ seat: BOB, flowId: result.flowId, ok: true, message: 'Signed in to Claude Design.' }])
    } finally {
      delete process.env.CLAUDE_CODE_CHILD_SESSION
    }
  })

  test("a refusal before any link fails the start with the CLI's own words", async () => {
    const { flows, spawned } = harness()
    const started = flows.start(HOST_LOGIN_SEAT, { kind: 'claude-design' })
    spawned[0]!.child.stdout.emit('data', '{"event":"done","ok":false,"message":"Claude Design sync is not available in this session."}\n')
    await expect(started).rejects.toThrow('Claude Design sync is not available in this session.')
  })

  test("another person cannot answer or cancel someone's sign-in", async () => {
    const { flows, spawned, finished } = harness()
    const started = flows.start(BOB, { kind: 'claude-design' })
    spawned[0]!.child.stdout.emit('data', '{"event":"pages","url":"https://claude.ai/manual"}\n')
    const result = await started
    if (result.state !== 'waiting') throw new Error('expected a waiting flow')
    await expect(flows.submit(EVE, result.flowId, 'code')).rejects.toThrow(/has ended/)
    expect(() => flows.cancel(EVE, result.flowId)).toThrow(/has ended/)
    expect(spawned[0]!.child.stdinWrites).toEqual([])
    expect(finished).toEqual([])
  })
})

describe('AgentAuthFlows: Codex MCP', () => {
  test('the callback address goes to stdin, and only a clean exit is a sign-in', async () => {
    const { flows, spawned, finished } = harness()
    const target = { kind: 'mcp' as const, provider: 'codex' as const, server: 'linear', cwd: '/tmp' }
    const started = flows.start(BOB, target)
    expect(spawned[0]?.args).toEqual(['mcp', 'login', '--no-browser', 'linear'])
    spawned[0]!.child.stdout.emit('data', 'Authorize `linear` by opening this URL in your browser: https://linear.app/oauth?x=1\nOAuth callback URL: ')
    const result = await started
    expect(result).toMatchObject({ state: 'waiting', url: 'https://linear.app/oauth?x=1', input: 'redirect-url' })
    if (result.state !== 'waiting') throw new Error('expected a waiting flow')
    await flows.submit(BOB, result.flowId, 'http://127.0.0.1:5555/callback?code=c&state=s')
    expect(spawned[0]!.child.stdinWrites).toEqual(['http://127.0.0.1:5555/callback?code=c&state=s\n'])
    spawned[0]!.child.stderr.emit('data', 'invalid MCP OAuth callback URL\n')
    spawned[0]!.child.emit('close', 1, null)
    expect(finished).toEqual([{ seat: BOB, flowId: result.flowId, ok: false, message: 'invalid MCP OAuth callback URL' }])
  })
})

describe('AgentAuthFlows: Claude MCP', () => {
  test("an already connected server is reported, not re-authorized: its status is the flow's only end signal", async () => {
    const session = new FakeMcpSession('connected', { requiresUserAction: true, callbackExpected: true, authUrl: 'https://mcp/auth' })
    const { flows } = harness(session)
    const result = await flows.start(HOST_LOGIN_SEAT, { kind: 'mcp', provider: 'claude-code', server: 'sentry', cwd: '/tmp' })
    expect(result).toMatchObject({ state: 'signed-in' })
    expect(session.closed).toBe(true)
  })

  test('waits for the server to connect, and the redirect address from another device finishes it', async () => {
    const session = new FakeMcpSession('needs-auth', { requiresUserAction: true, callbackExpected: true, authUrl: 'https://mcp/auth' })
    const { flows, finished } = harness(session)
    const result = await flows.start(HOST_LOGIN_SEAT, { kind: 'mcp', provider: 'claude-code', server: 'sentry', cwd: '/tmp' })
    expect(result).toMatchObject({ state: 'waiting', url: 'https://mcp/auth', input: 'redirect-url' })
    if (result.state !== 'waiting') throw new Error('expected a waiting flow')
    await tick()
    expect(finished).toEqual([])
    await flows.submit(HOST_LOGIN_SEAT, result.flowId, 'http://localhost:4444/callback?code=c')
    expect(session.submitted).toEqual(['http://localhost:4444/callback?code=c'])
    expect(finished.map((event) => event.ok)).toEqual([true])
    expect(session.closed).toBe(true)
  })

  test('a browser redirect on the host itself ends the flow once the server connects', async () => {
    const session = new FakeMcpSession('needs-auth', { requiresUserAction: true, callbackExpected: true, authUrl: 'https://mcp/auth' })
    const { flows, finished } = harness(session)
    await flows.start(HOST_LOGIN_SEAT, { kind: 'mcp', provider: 'claude-code', server: 'sentry', cwd: '/tmp' })
    session.current = 'connected'
    await tick()
    expect(finished.map((event) => event.ok)).toEqual([true])
  })

  test('a member with no Claude seat is told to sign in first', async () => {
    const { flows } = harness(new FakeMcpSession('needs-auth', { requiresUserAction: false, callbackExpected: false }))
    await expect(flows.start(BOB, { kind: 'mcp', provider: 'claude-code', server: 'sentry', cwd: '/tmp' })).rejects.toThrow('/login')
  })
})
