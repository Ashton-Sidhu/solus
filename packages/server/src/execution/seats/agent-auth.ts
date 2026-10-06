import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { AgentAuthFinishedEvent, AgentAuthMcpTarget, AgentAuthStartResult, AgentAuthTarget } from '@solus/contracts/agent-auth'
import type { Seat } from '@solus/contracts/seats'
import { getCliEnv } from '../../cli-env'
import { createLogger } from '../../logger'
import { resolveHomePath } from '../../platform/paths'
import { claudeSeatOf } from '../agents/claude/claude-backend'
import { openClaudeMcpAuthSession, type ClaudeMcpAuthSession } from '../agents/claude/claude-mcp-auth'
import { coerceAgentSignInCode, terminateProcessTree, type SpawnProcess } from './seat-connect'
import { seatEnv } from './seat-login'
import { seatKey, type SeatStore, type TurnSeat } from './seat-manager'

const log = createLogger('main', 'agent-auth')

/** A sign-in can wait this long for the person; then it ends as failed. */
const FLOW_TIMEOUT_MS = 15 * 60_000
/** How long a CLI gets to print where to sign in. */
const START_TIMEOUT_MS = 60_000
/** The SDK announces no end to an MCP sign-in, so the server's status is read at this interval. */
const MCP_STATUS_POLL_MS = 2_000
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

interface Flow {
  seat: Seat
  submit(value: string): Promise<void>
  cancel(): void
}

/**
 * Sign-ins an agent CLI keeps for its terminal, relayed like the seat connect
 * (docs/plans/agent-auth-commands.md): Claude Design, and one MCP server's OAuth
 * for Claude or Codex. Each runs in the caller's own seat, so the credential lands
 * where that person's turns read it. A flow belongs to the seat that started it.
 */
export class AgentAuthFlows {
  private readonly flows = new Map<string, Flow>()
  private readonly listeners = new Set<(event: AgentAuthFinishedEvent) => void>()
  private readonly spawnProcess: SpawnProcess
  private readonly openClaudeMcp: (opts: { cwd: string; seat: TurnSeat }) => Promise<ClaudeMcpAuthSession>

  constructor(private readonly deps: {
    seats: SeatStore
    spawnProcess?: SpawnProcess
    openClaudeMcp?: (opts: { cwd: string; seat: TurnSeat }) => Promise<ClaudeMcpAuthSession>
    flowTimeoutMs?: number
    mcpStatusPollMs?: number
  }) {
    this.spawnProcess = deps.spawnProcess ?? nodeSpawn
    this.openClaudeMcp = deps.openClaudeMcp ?? (({ cwd, seat }) => openClaudeMcpAuthSession({ cwd, seat: claudeSeatOf(seat) }))
  }

  onFinished(listener: (event: AgentAuthFinishedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(seat: Seat, target: AgentAuthTarget): Promise<AgentAuthStartResult> {
    // One sign-in per person at a time: a fresh start supersedes an abandoned one.
    for (const [flowId, flow] of this.flows) if (seatKey(flow.seat) === seatKey(seat)) this.finish(flowId, false, 'Sign-in was replaced by a new one.')
    if (target.kind === 'claude-design') return this.startDesign(seat)
    return target.provider === 'claude-code' ? this.startClaudeMcp(seat, target) : this.startCodexMcp(seat, target)
  }

  async submit(seat: Seat, flowId: string, value: string): Promise<void> {
    await this.flowOf(seat, flowId).submit(value)
  }

  cancel(seat: Seat, flowId: string): boolean {
    if (!this.flows.has(flowId)) return false
    this.flowOf(seat, flowId)
    this.finish(flowId, false, 'Sign-in was cancelled.')
    return true
  }

  async signOut(seat: Seat, target: AgentAuthMcpTarget): Promise<{ message: string }> {
    if (target.provider === 'codex') {
      await this.runToEnd(seat, target, ['mcp', 'logout', target.server])
      return { message: `Signed out of ${target.server}.` }
    }
    const session = await this.openClaudeMcp({ cwd: target.cwd, seat: this.claudeSeat(seat) })
    try {
      await session.clearAuth(target.server)
    } finally {
      await session.close()
    }
    return { message: `Signed out of ${target.server}.` }
  }

  /** The host is shutting down: every waiting sign-in ends. */
  stopAll(): void {
    for (const flowId of [...this.flows.keys()]) this.finish(flowId, false, 'The host stopped.')
  }

  // ── Claude Design: `claude design-login --json`, the VS Code extension's relay ──

  private startDesign(seat: Seat): Promise<AgentAuthStartResult> {
    const home = seat.kind === 'host-login' ? null : this.deps.seats.homeFor(seat, 'claude-code')
    const flowId = randomUUID()
    return this.relayProcess(seat, flowId, {
      command: 'claude',
      args: ['design-login', '--json'],
      cwd: home ?? homedir(),
      env: seatEnv('claude-code', home),
      // JSON lines: `pages` names where to sign in, `done` ends the sign-in.
      onLine: (line, relay) => {
        const event = parseDesignLoginLine(line)
        if (event?.event === 'pages') relay.waiting({ state: 'waiting', flowId, url: event.manual_url ?? event.url, input: 'code' })
        if (event?.event === 'done') relay.end(event.ok, event.ok ? 'Signed in to Claude Design.' : event.message ?? 'Claude Design sign-in failed.')
      },
      encodeInput: (value) => JSON.stringify({ code: value }),
      successMessage: null,
    })
  }

  // ── MCP servers ──

  private async startClaudeMcp(seat: Seat, target: AgentAuthMcpTarget): Promise<AgentAuthStartResult> {
    const { server } = target
    const session = await this.openClaudeMcp({ cwd: target.cwd, seat: this.claudeSeat(seat) })
    let response
    try {
      const status = await session.status(server)
      if (!status) throw new Error(`Claude has no MCP server named "${server}" in this project.`)
      if (status.status === 'disabled') throw new Error(`"${server}" is disabled. Run /mcp enable ${server}, then sign in.`)
      // Its status is the only end signal, so a connected server must be signed out first.
      if (status.status === 'connected') {
        await session.close()
        return { state: 'signed-in', message: `"${server}" is already connected. Run /mcp logout ${server} first to sign in with another account.` }
      }
      response = await session.authenticate(server)
    } catch (error) {
      await session.close()
      throw error
    }
    if (!response.requiresUserAction || !response.authUrl) {
      await session.close()
      return { state: 'signed-in', message: `Signed in to ${server}.` }
    }
    if (!response.callbackExpected) {
      await session.close()
      return { state: 'external', url: response.authUrl, message: `Finish on claude.ai. ${server} is available from the next turn.` }
    }

    const flowId = randomUUID()
    const done = `Signed in to ${server}. Its tools are available from the next turn.`
    const poll = setInterval(() => {
      void session.status(server).then((status) => {
        if (status?.status === 'connected') this.finish(flowId, true, done)
      }).catch(() => { /* the next read tries again */ })
    }, this.deps.mcpStatusPollMs ?? MCP_STATUS_POLL_MS)
    poll.unref()
    this.track(flowId, {
      seat,
      // On another device the browser cannot reach the host's callback; the address it ended on finishes the sign-in.
      submit: async (value) => {
        await session.submitCallbackUrl(server, value)
        this.finish(flowId, true, done)
      },
      cancel: () => {
        clearInterval(poll)
        void session.close()
      },
    })
    log.info('agent_auth_started', { flowId, kind: 'mcp', provider: 'claude-code', seat: seatKey(seat) })
    return { state: 'waiting', flowId, url: response.authUrl, input: 'redirect-url' }
  }

  private startCodexMcp(seat: Seat, target: AgentAuthMcpTarget): Promise<AgentAuthStartResult> {
    const flowId = randomUUID()
    return this.relayProcess(seat, flowId, {
      command: 'codex',
      args: ['mcp', 'login', '--no-browser', target.server],
      cwd: resolveHomePath(target.cwd),
      env: seatEnv('codex', this.codexHome(seat)),
      // "Authorize `name` by opening this URL in your browser: <url>", then a prompt for the callback URL.
      onLine: (line, relay) => {
        const url = /https?:\/\/\S+/.exec(line)?.[0]
        if (url) relay.waiting({ state: 'waiting', flowId, url, input: 'redirect-url' })
      },
      encodeInput: (value) => value,
      successMessage: `Signed in to ${target.server}. Its tools are available from the next turn.`,
    })
  }

  // ── Plumbing ──

  private claudeSeat(seat: Seat): TurnSeat {
    const turnSeat = this.deps.seats.connectedSeat(seat, 'claude-code')
    if (!turnSeat) throw new Error('Connect your Claude seat first: run /login.')
    return turnSeat
  }

  private codexHome(seat: Seat): string | null {
    return seat.kind === 'host-login' ? null : this.deps.seats.homeFor(seat, 'codex')
  }

  private childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = getCliEnv({ FORCE_COLOR: '0', ...extra })
    env.PATH = `${this.deps.seats.shimBinDir()}:${env.PATH ?? ''}`
    // The CLI refuses a sign-in it believes a Claude Code session started.
    delete env.CLAUDE_CODE_CHILD_SESSION
    // A sign-in must be the person's own: nothing the host process carries may answer for it.
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    delete env.OPENAI_API_KEY
    return env
  }

  /**
   * Runs a sign-in CLI: answers once it names where to sign in, writes what the
   * person brings back to stdin, and ends the flow when the process does.
   */
  private relayProcess(seat: Seat, flowId: string, spec: {
    command: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    /** Reads one complete output line; `end` finishes the flow from what the CLI printed. */
    onLine: (line: string, relay: { waiting: (result: AgentAuthStartResult) => void; end: (ok: boolean, message: string) => void }) => void
    encodeInput: (value: string) => string
    /** The message for a clean exit; null when the output already ended the flow. */
    successMessage: string | null
  }): Promise<AgentAuthStartResult> {
    const child = this.spawnProcess(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: this.childEnv(spec.env),
    })
    let output = ''
    let errorOutput = ''
    let pending = ''
    let started = false
    let resolveStart: (result: AgentAuthStartResult) => void = () => {}
    let rejectStart: (error: Error) => void = () => {}
    const startResult = new Promise<AgentAuthStartResult>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    const waiting = (result: AgentAuthStartResult) => {
      if (started) return
      started = true
      resolveStart(result)
    }
    const end = (ok: boolean, message: string) => {
      clearTimeout(startTimer)
      if (!started) rejectStart(new Error(message))
      this.finish(flowId, ok, message)
    }
    const startTimer = setTimeout(() => rejectStart(new Error(`${spec.command} did not print a sign-in link.`)), START_TIMEOUT_MS)
    startTimer.unref()

    this.track(flowId, {
      seat,
      submit: async (value) => {
        const stdin = child.stdin
        if (!stdin?.writable) throw new Error('This sign-in is not waiting for input.')
        stdin.write(`${spec.encodeInput(coerceAgentSignInCode(value))}\n`)
      },
      cancel: () => terminateProcessTree(child, 'SIGTERM'),
    })
    const onOutput = (chunk: Buffer | string) => {
      const text = chunk.toString().replace(ANSI_RE, '')
      output = `${output}${text}`.slice(-8_192)
      pending += text
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) spec.onLine(line, { waiting, end })
        newline = pending.indexOf('\n')
      }
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', (chunk: Buffer | string) => {
      errorOutput = `${errorOutput}${chunk.toString().replace(ANSI_RE, '')}`.slice(-4_096)
      onOutput(chunk)
    })
    // A flow the output already ended is gone, so these are no-ops for it.
    child.once('error', (error) => end(false, error.message))
    child.once('close', (code, signal) => {
      if (code === 0 && spec.successMessage) return end(true, spec.successMessage)
      // Why it failed is on stderr; stdout ends with the prompt it was waiting on.
      const tail = (errorOutput.trim() || output.trim()).split(/\r?\n/).filter(Boolean).at(-1)?.trim()
      end(false, signal ? 'Sign-in was cancelled.' : tail || `${spec.command} exited with code ${code ?? 'unknown'}.`)
    })
    log.info('agent_auth_started', { flowId, command: `${spec.command} ${spec.args.slice(0, 2).join(' ')}`, seat: seatKey(seat) })
    return startResult.catch((error: unknown) => {
      terminateProcessTree(child, 'SIGTERM')
      throw error
    })
  }

  /** A CLI command with no interaction, such as `codex mcp logout`. */
  private runToEnd(seat: Seat, target: AgentAuthMcpTarget, args: string[]): Promise<void> {
    const child = this.spawnProcess('codex', args, {
      cwd: resolveHomePath(target.cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.childEnv(seatEnv('codex', this.codexHome(seat))),
    })
    let output = ''
    const collect = (chunk: Buffer | string) => { output = `${output}${chunk.toString()}`.slice(-4_096) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    return new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(output.replace(ANSI_RE, '').trim() || `codex exited with code ${code ?? 'unknown'}`)))
    })
  }

  private track(flowId: string, flow: Flow): void {
    this.flows.set(flowId, flow)
    const timer = setTimeout(() => this.finish(flowId, false, 'The sign-in timed out. Try again.'), this.deps.flowTimeoutMs ?? FLOW_TIMEOUT_MS)
    timer.unref()
    const cancel = flow.cancel
    flow.cancel = () => {
      clearTimeout(timer)
      cancel()
    }
  }

  private flowOf(seat: Seat, flowId: string): Flow {
    const flow = this.flows.get(flowId)
    // Another person's flow id is as unknown as a finished one.
    if (!flow || seatKey(flow.seat) !== seatKey(seat)) throw new Error('This sign-in has ended. Start it again.')
    return flow
  }

  /** Ends a flow once: its process or session stops and its seat's clients hear the result. */
  private finish(flowId: string, ok: boolean, message: string): void {
    const flow = this.flows.get(flowId)
    if (!flow) return
    this.flows.delete(flowId)
    flow.cancel()
    log.info('agent_auth_finished', { flowId, ok })
    for (const listener of this.listeners) listener({ seat: flow.seat, flowId, ok, message })
  }
}

type DesignLoginLine =
  | { event: 'pages'; url: string; manual_url?: string }
  | { event: 'done'; ok: boolean; message?: string }

function parseDesignLoginLine(line: string): DesignLoginLine | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || !('event' in value)) return null
  if (value.event === 'pages' && 'url' in value && typeof value.url === 'string') {
    const manualUrl = 'manual_url' in value && typeof value.manual_url === 'string' ? value.manual_url : undefined
    return manualUrl ? { event: 'pages', url: value.url, manual_url: manualUrl } : { event: 'pages', url: value.url }
  }
  if (value.event === 'done' && 'ok' in value && typeof value.ok === 'boolean') {
    const message = 'message' in value && typeof value.message === 'string' ? value.message : undefined
    return message ? { event: 'done', ok: value.ok, message } : { event: 'done', ok: value.ok }
  }
  return null
}
