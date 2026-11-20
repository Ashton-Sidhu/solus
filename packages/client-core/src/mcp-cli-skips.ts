import type { IntegrationCliSkip } from '@solus/contracts/integration-types'

/**
 * The words for the CLI copies of one MCP server that the person's runs left
 * out (docs/plans/mcp-first-class.md §8.5), the same on desktop, web, and
 * mobile. One line for each copy. Claude Code does not say which copy it had,
 * so its line names the address; Codex names the copy and its config file.
 */
export function cliSkipLines(skips: readonly IntegrationCliSkip[]): string[] {
  return skips.map((skip) => {
    if (skip.provider === 'claude-code') return 'Claude Code does not load its own copy at this address.'
    const name = skip.serverName ? `“${skip.serverName}”` : 'its own copy'
    if (skip.scope === 'user') return `Codex does not load ${name} from ~/.codex/config.toml.`
    if (skip.scope === 'project') return `Codex does not load ${name} from .codex/config.toml in the project.`
    return `Codex does not load ${name}.`
  })
}

/** Under the lines: where the skip applies, and how to give the copy back. */
export const CLI_SKIP_NOTE = 'Only in runs that Solus starts, so the agent sees each tool once. Remove this server to give the copy back.'
