import type { Settings } from '@anthropic-ai/claude-agent-sdk'
import { comparableServerUrl, type AppliedCliSkip, type CliSkip, type RunCliSkip } from '../../../integrations/cli-skips'

type DeniedMcpServer = NonNullable<Settings['deniedMcpServers']>[number]

/** The servers a Claude Code run denies, and what it reports once its query starts. */
export interface ClaudeCliSkip {
  denied: DeniedMcpServer[]
  applied: AppliedCliSkip[]
}

/** One run's deny list, and the report it sends once its query starts. */
export interface ClaudeRunSkip {
  denied: DeniedMcpServer[]
  report: () => void
}

/** A run's own skip. A bare run loads no server of the CLI (`strictMcpConfig`), so it denies and reports nothing. */
export function claudeRunSkip(run: { bare?: unknown; cliSkip?: RunCliSkip }): ClaudeRunSkip {
  if (run.bare || !run.cliSkip) return { denied: [], report: () => {} }
  const { cliSkip } = run
  const { denied, applied } = claudeDeniedMcpServers(cliSkip.servers)
  return { denied, report: () => cliSkip.report('claude-code', applied) }
}

/**
 * The CLI skip for Claude Code (docs/plans/mcp-first-class.md §8.5): one
 * `deniedMcpServers` entry for each server, in the run's flag settings. The CLI
 * leaves a denied server out of the user and the project scope (proven in
 * phase C2: `mcp-c2-handoff.md`) and starts no process for it; the in-process `solus` server is
 * never denied. A command matches exactly. A URL is a pattern in which `*` is a
 * wildcard, so one with `*` is not denied: it could match a server that only
 * looks similar. The CLI itself folds the case of the host and the default
 * port, but not a slash at the end of the path, so a URL gets both forms.
 * Claude Code does not say which copy it had, so an applied skip has no name.
 */
export function claudeDeniedMcpServers(servers: readonly CliSkip[]): ClaudeCliSkip {
  const denied: DeniedMcpServer[] = []
  const applied: AppliedCliSkip[] = []
  for (const { integrationId, address } of servers) {
    if (address.kind === 'command') {
      denied.push({ serverCommand: [address.command, ...address.args] })
    } else {
      const url = comparableServerUrl(address.url)
      if (!url || url.includes('*')) continue
      denied.push({ serverUrl: url })
      if (!url.endsWith('/')) denied.push({ serverUrl: `${url}/` })
    }
    applied.push({ integrationId })
  }
  return { denied, applied }
}
