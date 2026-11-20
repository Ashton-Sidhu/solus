import type { Integration, IntegrationCliSkip } from '@solus/contracts/integration-types'

/**
 * The CLI skip (docs/plans/mcp-first-class.md §8.5): a run leaves out the
 * provider CLI's own copy of each server that Solus runs in that run, so the
 * agent sees each tool once, through Solus, and the copy's credential does not
 * load in the agent process. This module decides which servers and compares
 * addresses. Each provider adapter only turns the decision into its own
 * settings (`claude-cli-skip.ts`, `codex-cli-skip.ts`). Nothing here reads or
 * writes a provider's files; a skip lasts for one run.
 */

/** Where a server is: a URL (Streamable HTTP) or a command with its arguments (stdio). */
export type McpServerAddress =
  | { kind: 'url'; url: string }
  | { kind: 'command'; command: string; args: readonly string[] }

/** A server that Solus runs in one run, whose CLI copy that run leaves out. */
export interface CliSkip {
  integrationId: string
  address: McpServerAddress
}

/** One CLI copy that an adapter left out. Codex names it; Claude Code cannot. */
export interface AppliedCliSkip {
  integrationId: string
  serverName?: string
  scope?: IntegrationCliSkip['scope']
}

export type CliSkipProvider = IntegrationCliSkip['provider']

/** What a run carries to its provider adapter: the servers to leave out, and where to report what it did. */
export interface RunCliSkip {
  servers: CliSkip[]
  /** Called once by the adapter when the run starts; never throws. */
  report(provider: CliSkipProvider, applied: AppliedCliSkip[]): void
}

/**
 * A URL as two servers are compared: the scheme and host in lower case and the
 * default port left out (the URL parser does both), no fragment, and no slash
 * at the end of the path. The query stays: it can choose another server. Null
 * for a URL that does not parse or is not HTTP.
 */
export function comparableServerUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.href
}

/**
 * Whether two addresses are the same server. A URL: equal after
 * `comparableServerUrl`. A command: the same program and the same arguments in
 * the same order, exactly; the environment is not part of the address, because
 * it holds the person's values, not the server. A server that only looks
 * similar (`npx` against its full path, arguments in another order) is another
 * server.
 */
export function sameServerAddress(a: McpServerAddress, b: McpServerAddress): boolean {
  if (a.kind === 'url' && b.kind === 'url') {
    const left = comparableServerUrl(a.url)
    return left !== null && left === comparableServerUrl(b.url)
  }
  if (a.kind === 'command' && b.kind === 'command') {
    return a.command === b.command && a.args.length === b.args.length && a.args.every((arg, index) => arg === b.args[index])
  }
  return false
}

/** The address of an integration that a CLI could also have; a `solus` server runs in the host and has none. */
export function cliSkipOf(integration: Pick<Integration, 'id' | 'kind' | 'url' | 'launch'>): CliSkip | null {
  if (integration.kind === 'mcp') return { integrationId: integration.id, address: { kind: 'url', url: integration.url } }
  if (integration.kind === 'stdio' && integration.launch) {
    return { integrationId: integration.id, address: { kind: 'command', command: integration.launch.command, args: integration.launch.args } }
  }
  return null
}

const NO_SKIPS: readonly IntegrationCliSkip[] = []

/**
 * What the last run of each provider left out, for each person and integration.
 * It is in memory: after a restart a note shows again at the next run. An
 * entry goes when the integration is removed or changed (a tool switch can turn
 * off every tool, and then a run takes nothing from it); the next run that
 * leaves the copy out writes it again.
 */
export class CliSkipLog {
  private readonly entries = new Map<string, Map<CliSkipProvider, IntegrationCliSkip[]>>()
  private readonly listeners: Array<(integrationId: string) => void> = []

  /**
   * A run of `provider` for `personKey` left out `applied`. `integrationIds` are
   * the integrations of that run: one with nothing in `applied` loses its entry.
   */
  record(personKey: string | null, provider: CliSkipProvider, integrationIds: readonly string[], applied: readonly AppliedCliSkip[]): void {
    for (const integrationId of integrationIds) {
      const key = entryKey(personKey, integrationId)
      const copies = applied.filter((skip) => skip.integrationId === integrationId).map(({ serverName, scope }): IntegrationCliSkip => {
        const entry: IntegrationCliSkip = { provider }
        if (serverName) entry.serverName = serverName
        if (scope) entry.scope = scope
        return entry
      })
      const byProvider = this.entries.get(key) ?? new Map<CliSkipProvider, IntegrationCliSkip[]>()
      const previous = byProvider.get(provider) ?? NO_SKIPS
      if (JSON.stringify(previous) === JSON.stringify(copies)) continue
      if (copies.length) byProvider.set(provider, copies)
      else byProvider.delete(provider)
      if (byProvider.size) this.entries.set(key, byProvider)
      else this.entries.delete(key)
      this.notify(integrationId)
    }
  }

  /** The person's skips of one integration, Claude Code first. */
  for(integrationId: string, personKey: string | null): IntegrationCliSkip[] {
    const byProvider = this.entries.get(entryKey(personKey, integrationId))
    if (!byProvider) return []
    return [...(byProvider.get('claude-code') ?? NO_SKIPS), ...(byProvider.get('codex') ?? NO_SKIPS)]
  }

  /** Drops every person's entries of an integration that was removed or changed. */
  forget(integrationId: string): void {
    let dropped = false
    for (const key of this.entries.keys()) {
      if (key.endsWith(`\u0000${integrationId}`)) {
        this.entries.delete(key)
        dropped = true
      }
    }
    if (dropped) this.notify(integrationId)
  }

  onChanged(listener: (integrationId: string) => void): void {
    this.listeners.push(listener)
  }

  private notify(integrationId: string): void {
    for (const listener of this.listeners) listener(integrationId)
  }
}

function entryKey(personKey: string | null, integrationId: string): string {
  return `${personKey ?? ''}\u0000${integrationId}`
}

/** The host's one log; boot sends `integration.changed` with `change: 'facts'` when it changes. */
export const cliSkipLog = new CliSkipLog()
