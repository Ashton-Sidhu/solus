import type { AgentAuthCommand, AgentAuthStartResult } from '@solus/contracts/agent-auth'
import type { SeatProvider } from '@solus/contracts/seats'
import type { HostConnection } from '../hosts/host-connections'
import { Listeners } from '../../lib/listeners'

/**
 * The sign-in commands a conversation runs itself instead of sending them to
 * the agent (`/login`, `/design-login`, `/mcp login|logout <server>`;
 * docs/plans/agent-auth-commands.md). The host runs the sign-in in the
 * caller's own seat; this device opens the page and hands back the code or the
 * address the browser ended on. `/login` is the seat connect and ends on
 * `host.seatChanged`; the others end on `host.agentAuthFinished` for their
 * `flowId`.
 */

export type AgentAuthView =
  | { step: 'closed' }
  | { step: 'starting'; title: string }
  | {
      step: 'waiting'
      title: string
      url: string
      /** The device code to type on the page (Codex `/login`). */
      userCode: string | null
      /** What the host needs back, or null when the page finishes the sign-in. */
      input: 'code' | 'redirect-url' | null
      submitted: boolean
      busy: boolean
      error: string | null
    }
  /** `url` is set when the sign-in finishes on the provider's site. */
  | { step: 'finished'; title: string; ok: boolean; message: string; url: string | null }

type Flow = { kind: 'seat'; provider: SeatProvider } | { kind: 'agent'; flowId: string }

export interface AgentAuthDeps {
  connection: Pick<HostConnection, 'api' | 'events' | 'onReset'>
  /** A short note in the transcript. */
  notice(text: string, tone: 'info' | 'error'): void
}

export class AgentAuthFlow {
  readonly changes = new Listeners()
  view: AgentAuthView = { step: 'closed' }
  private flow: Flow | null = null
  /** Bumps on each command; an answer for an older one is dropped. */
  private attempt = 0
  private readonly cleanups: Array<() => void> = []

  constructor(private readonly deps: AgentAuthDeps) {
    const { events } = deps.connection
    this.cleanups.push(events.subscribe('host.agentAuthFinished', (event) => {
      if (this.flow?.kind !== 'agent' || this.flow.flowId !== event.flowId) return
      this.finish(event.ok, event.message)
    }))
    this.cleanups.push(events.subscribe('host.seatChanged', (event) => {
      if (this.flow?.kind !== 'seat' || this.flow.provider !== event.provider || event.state === 'connecting') return
      if (event.state === 'connected') this.finish(true, `Signed in to ${providerName(event.provider)}.`)
      else this.finish(false, event.error ?? `${providerName(event.provider)} did not sign in.`)
    }))
    this.cleanups.push(deps.connection.onReset(() => { void this.recover() }))
  }

  snapshot = (): AgentAuthView => this.view

  /** Runs one parsed command. `cwd` is the session's working directory. */
  async run(command: AgentAuthCommand, cwd: string): Promise<void> {
    if (command.kind === 'mcp-login' || command.kind === 'mcp-logout') {
      if (!command.server) {
        this.deps.notice(`Name a server: /mcp ${command.kind === 'mcp-login' ? 'login' : 'logout'} <server>`, 'info')
        return
      }
      if (command.kind === 'mcp-logout') {
        try {
          const result = await this.deps.connection.api.agentAuthSignOut({ kind: 'mcp', provider: command.provider, server: command.server, cwd })
          this.deps.notice(result.message, 'info')
        } catch (error) {
          this.deps.notice(`${command.server} was not signed out: ${errorText(error)}`, 'error')
        }
        return
      }
    }
    await this.cancelLive()
    const attempt = ++this.attempt
    const title = command.kind === 'login' ? `Sign in to ${providerName(command.provider)}`
      : command.kind === 'design-login' ? 'Sign in to Claude Design' : `Sign in to ${command.server}`
    this.set({ step: 'starting', title })
    try {
      if (command.kind === 'login') {
        const started = await this.deps.connection.api.seatConnectStart({ provider: command.provider })
        // Dismissed while it started: the host stops waiting too.
        if (attempt !== this.attempt) return void this.deps.connection.api.seatConnectCancel({ provider: command.provider }).catch(() => undefined)
        this.flow = { kind: 'seat', provider: command.provider }
        this.set({ step: 'waiting', title, url: started.verificationUrl, userCode: started.userCode ?? null,
          input: started.requiresCodeInput ? 'code' : null, submitted: false, busy: false, error: null })
        return
      }
      const result: AgentAuthStartResult = await this.deps.connection.api.agentAuthStart(command.kind === 'design-login'
        ? { kind: 'claude-design' }
        : { kind: 'mcp', provider: command.provider, server: command.server ?? '', cwd })
      if (attempt !== this.attempt) {
        if (result.state === 'waiting') void this.deps.connection.api.agentAuthCancel({ flowId: result.flowId }).catch(() => undefined)
        return
      }
      if (result.state === 'waiting') {
        this.flow = { kind: 'agent', flowId: result.flowId }
        this.set({ step: 'waiting', title, url: result.url, userCode: null, input: result.input, submitted: false, busy: false, error: null })
      } else {
        this.set({ step: 'finished', title, ok: true, message: result.message, url: result.state === 'external' ? result.url : null })
      }
    } catch (error) {
      if (attempt === this.attempt) this.set({ step: 'finished', title, ok: false, message: errorText(error), url: null })
    }
  }

  /** Hands the host the code, or the address the browser ended on. */
  async submit(value: string): Promise<void> {
    const flow = this.flow
    const view = this.view
    if (!flow || view.step !== 'waiting' || !value.trim()) return
    this.set({ ...view, busy: true, error: null })
    try {
      if (flow.kind === 'seat') await this.deps.connection.api.seatConnectSubmitCode({ provider: flow.provider, code: value.trim() })
      else await this.deps.connection.api.agentAuthSubmit({ flowId: flow.flowId, value: value.trim() })
      if (this.flow === flow && this.view.step === 'waiting') this.set({ ...this.view, busy: false, submitted: true })
    } catch (error) {
      if (this.flow === flow && this.view.step === 'waiting') this.set({ ...this.view, busy: false, error: errorText(error) })
    }
  }

  /** Stops the sign-in on the host and closes the sheet. */
  async cancel(): Promise<void> {
    const view = this.view
    if (view.step !== 'waiting') return this.dismiss()
    this.set({ ...view, busy: true, error: null })
    try {
      await this.stopOnHost()
      this.dismiss()
    } catch (error) {
      if (this.view.step === 'waiting') this.set({ ...this.view, busy: false, error: errorText(error) })
    }
  }

  /** Closes a finished or starting sheet. */
  dismiss(): void {
    this.attempt += 1
    this.flow = null
    this.set({ step: 'closed' })
  }

  close(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    void this.cancelLive()
  }

  // ─── Internals ───

  private async stopOnHost(): Promise<void> {
    const flow = this.flow
    if (!flow) return
    if (flow.kind === 'seat') await this.deps.connection.api.seatConnectCancel({ provider: flow.provider })
    else await this.deps.connection.api.agentAuthCancel({ flowId: flow.flowId })
    if (this.flow === flow) this.flow = null
  }

  /** A sign-in still waiting is stopped before another starts or the conversation closes. */
  private async cancelLive(): Promise<void> {
    await this.stopOnHost().catch(() => undefined)
    this.flow = null
  }

  /**
   * After a reset the host may have sent the end while this client was away.
   * A seat is read again; an agent sign-in's end is not kept, so it starts over.
   */
  private async recover(): Promise<void> {
    const flow = this.flow
    if (!flow) return
    if (flow.kind === 'agent') {
      this.finish(false, 'The connection to the host was reset. Run the command again.')
      return
    }
    try {
      const seat = (await this.deps.connection.api.seatList()).find((status) => status.provider === flow.provider)
      if (this.flow !== flow || !seat || seat.state === 'connecting') return
      if (seat.state === 'connected') this.finish(true, `Signed in to ${providerName(flow.provider)}.`)
      else this.finish(false, seat.error ?? `${providerName(flow.provider)} did not sign in.`)
    } catch {
      // The next reconnect reads the seat again.
    }
  }

  private finish(ok: boolean, message: string): void {
    const view = this.view
    this.flow = null
    if (view.step === 'closed') return
    this.set({ step: 'finished', title: view.title, ok, message, url: null })
  }

  private set(view: AgentAuthView): void {
    this.view = view
    this.changes.notify()
  }
}

function providerName(provider: SeatProvider): string {
  return provider === 'claude-code' ? 'Claude' : 'Codex'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
