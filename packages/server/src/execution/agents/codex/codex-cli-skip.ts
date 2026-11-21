import { z } from 'zod'
import { sameServerAddress, type AppliedCliSkip, type CliSkip, type McpServerAddress, type RunCliSkip } from '../../../integrations/cli-skips'
import { codexMcpServerSchema } from '../../../integrations/found/codex-servers'
import { createLogger } from '../../../logger'
import { resolveHomePath } from '../../../platform/paths'
import type { CodexAppServerClient } from './codex-agent'
import type { ConfigReadResponse } from './generated/v2/ConfigReadResponse'

const log = createLogger('CodexCliSkip', 'codex-cli-skip.ts')

/** The fields of one `mcp_servers.<name>` entry that make its address, and whether it is on. */
const codexAddressSchema = codexMcpServerSchema.pick({ command: true, args: true, url: true, enabled: true })
const codexMcpServersSchema = z.record(z.string(), codexAddressSchema)

/** The thread config keys that turn the run's CLI copies off, and the copies they name. */
export interface CodexCliSkip {
  config: Record<string, false>
  applied: AppliedCliSkip[]
}

/**
 * The CLI skip for Codex (docs/plans/mcp-first-class.md §8.5): `config/read`
 * for the run's working directory names each configured server with its
 * address; each one with the address of a server Solus runs gets
 * `mcp_servers.<name>.enabled = false` in the thread config. Codex then starts
 * no process for it (proven in phase C2: `mcp-c2-handoff.md`). The config
 * layer of the server's address keys says where the copy is.
 */
export function codexSkipConfig(read: Pick<ConfigReadResponse, 'config' | 'origins'>, servers: readonly CliSkip[]): CodexCliSkip {
  const config: Record<string, false> = {}
  const applied: AppliedCliSkip[] = []
  const configured = codexMcpServersSchema.safeParse(read.config.mcp_servers)
  if (!configured.success) return { config, applied }
  for (const [name, entry] of Object.entries(configured.data)) {
    // One the person turned off is not loaded anyway, so it is not left out by Solus.
    if (entry.enabled === false) continue
    const address = addressOf(entry)
    const server = address && servers.find((skip) => sameServerAddress(skip.address, address))
    if (!server) continue
    config[`mcp_servers.${name}.enabled`] = false
    const layer = (read.origins[`mcp_servers.${name}.command`] ?? read.origins[`mcp_servers.${name}.url`])?.name.type
    const skip: AppliedCliSkip = { integrationId: server.integrationId, serverName: name }
    if (layer === 'user' || layer === 'project') skip.scope = layer
    applied.push(skip)
  }
  return { config, applied }
}

/**
 * The thread config that leaves out the run's CLI copies, read on the run's own
 * app-server client: no process starts for it. With no server to leave out it
 * reads nothing. A bare run turns off every configured server already
 * (`bareThreadConfig`). A failed read leaves every copy loaded, as before C2.
 */
export async function readCodexSkipConfig(client: Pick<CodexAppServerClient, 'request'>, cwd: string, run: { bare?: unknown; cliSkip?: RunCliSkip }): Promise<Record<string, false>> {
  const { cliSkip } = run
  if (run.bare || !cliSkip) return {}
  if (!cliSkip.servers.length) {
    cliSkip.report('codex', [])
    return {}
  }
  try {
    const { config, applied } = codexSkipConfig(await client.request('config/read', { cwd: resolveHomePath(cwd) }), cliSkip.servers)
    cliSkip.report('codex', applied)
    return config
  } catch (error) {
    log.warn('codex_cli_skip_read_failed', { error: error instanceof Error ? error.message : String(error) })
    return {}
  }
}

function addressOf(entry: z.infer<typeof codexAddressSchema>): McpServerAddress | null {
  if (entry.url) return { kind: 'url', url: entry.url }
  if (entry.command) return { kind: 'command', command: entry.command, args: entry.args ?? [] }
  return null
}
