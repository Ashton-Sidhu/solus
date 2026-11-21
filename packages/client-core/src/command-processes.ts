import type { Integration, IntegrationConnection, IntegrationFacts } from '@solus/contracts/integration-types'
import { commandProcessStatus, type CommandProcessActionKind, type CommandProcessStatus } from '@solus/contracts/integrations/command-server'
import type { HostApi } from './host-api'

export type CommandProcessApi = Pick<HostApi, 'integrationFacts' | 'integrationProcessStart' | 'integrationProcessStop'>

export interface CommandProcessesDeps {
  /** The host's API now; null while this client has no connection to it. */
  api(): CommandProcessApi | null
  /**
   * Where the state is kept. A Svelte client gives a `SvelteMap` and a
   * `SvelteSet`, so a row that reads one key wakes for that key only.
   */
  facts: Map<string, IntegrationFacts>
  starting: Set<string>
  errors: Map<string, string>
  /** After each change of the state, for a client that renders from a snapshot. */
  onChange?(): void
  /** A facts answer landed, from a read or a start. */
  onFacts?(integrationId: string, facts: IntegrationFacts): void
  /** A start answered: the command runs. */
  onStarted?(integrationId: string): void
}

/**
 * The person's processes of the commands of one host
 * (docs/plans/mcp-first-class.md §7.7), with one rule for desktop, web, and
 * mobile: the facts of each command and loopback server, read with a stale
 * guard; Start and test, Start again, Test again, and Stop; and the state a
 * row shows. A read starts no command (§7.3). The client reads the facts
 * again on the list, a reconnect, and `integration.changed`.
 */
export class CommandProcesses {
  /** Per integration: bumped by every read and start, so an older answer does not land. */
  private readonly reads = new Map<string, number>()

  constructor(private readonly deps: CommandProcessesDeps) {}

  factsOf(integrationId: string): IntegrationFacts | undefined {
    return this.deps.facts.get(integrationId)
  }

  /** Why the last start or stop from this client failed. */
  errorOf(integrationId: string): string | undefined {
    return this.deps.errors.get(integrationId)
  }

  /** A start or test from this client runs now. */
  isStarting(integrationId: string): boolean {
    return this.deps.starting.has(integrationId)
  }

  /** Whether a server on the host's loopback does not run now (§9.3); false while unknown. */
  isNotRunning(integration: Integration): boolean {
    return this.deps.facts.get(integration.id)?.reachable === 'not-running'
  }

  /** A command's process state for its row, or null for a server at an address. */
  statusOf(integration: Integration, connection: IntegrationConnection | null | undefined, mayRunCommands: boolean): CommandProcessStatus | null {
    if (integration.kind !== 'stdio') return null
    return commandProcessStatus({
      facts: this.deps.facts.get(integration.id),
      isStarting: this.deps.starting.has(integration.id),
      mayRunCommands,
      needsValues: integration.auth.kind === 'env' && connection?.status !== 'connected',
    })
  }

  async load(integrationId: string): Promise<void> {
    const api = this.deps.api()
    if (!api) return
    const read = this.nextRead(integrationId)
    try {
      const facts = await api.integrationFacts({ id: integrationId })
      if (this.reads.get(integrationId) === read) this.put(integrationId, facts)
    } catch {
      // The row keeps the last state it read; the next event or reconnect reads again.
    }
  }

  /** Start and test, Start again, or with `recheck` Test again: the host starts the person's process and lists its tools. */
  async start(integrationId: string, recheck = false): Promise<boolean> {
    const api = this.deps.api()
    if (!api || this.deps.starting.has(integrationId)) return false
    this.deps.starting.add(integrationId)
    this.deps.errors.delete(integrationId)
    this.deps.onChange?.()
    try {
      const facts = await api.integrationProcessStart({ id: integrationId, recheck })
      // The start's answer is newer than a read in flight.
      this.nextRead(integrationId)
      this.put(integrationId, facts)
      this.deps.onStarted?.(integrationId)
      return true
    } catch (cause) {
      this.fail(integrationId, cause, 'The command did not start.')
      void this.load(integrationId)
      return false
    } finally {
      this.deps.starting.delete(integrationId)
      this.deps.onChange?.()
    }
  }

  /** Stop, and Cancel of a start that runs: the next use starts the command again. */
  async stop(integrationId: string): Promise<boolean> {
    const api = this.deps.api()
    if (!api) return false
    this.deps.errors.delete(integrationId)
    this.deps.onChange?.()
    try {
      await api.integrationProcessStop({ id: integrationId })
    } catch (cause) {
      this.fail(integrationId, cause, 'Could not stop the command.')
      return false
    }
    await this.load(integrationId)
    return true
  }

  /** The action of a process row's button. */
  run(integrationId: string, kind: CommandProcessActionKind): Promise<boolean> {
    return kind === 'stop' || kind === 'cancel' ? this.stop(integrationId) : this.start(integrationId, kind === 'test-again')
  }

  /** The integration is gone from the host: its state goes too. */
  forget(integrationId: string): void {
    this.nextRead(integrationId)
    this.deps.facts.delete(integrationId)
    this.deps.errors.delete(integrationId)
    this.deps.onChange?.()
  }

  private put(integrationId: string, facts: IntegrationFacts): void {
    this.deps.facts.set(integrationId, facts)
    this.deps.onFacts?.(integrationId, facts)
    this.deps.onChange?.()
  }

  private fail(integrationId: string, cause: unknown, fallback: string): void {
    const message = cause instanceof Error ? cause.message.trim() : ''
    this.deps.errors.set(integrationId, message || fallback)
    this.deps.onChange?.()
  }

  private nextRead(integrationId: string): number {
    const read = (this.reads.get(integrationId) ?? 0) + 1
    this.reads.set(integrationId, read)
    return read
  }
}
