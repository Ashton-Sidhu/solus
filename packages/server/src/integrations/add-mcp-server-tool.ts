import { z } from 'zod'
import type { FoundServer, Integration, IntegrationFacts } from '@solus/contracts/integration-types'
import { foundUnsupportedText } from '@solus/contracts/integrations/found-server-labels'
import { INTERNAL_PRINCIPAL, type Principal } from '../admission/principal'
import { workspaceToolAuthority } from '../admission/workspace-tool-authority'
import type { AgentTool, AgentToolResult } from '../execution/agents/tools/agent-tool'
import { createLogger } from '../logger'
import { currentPersonKey } from '../vault/acting-scope'
import type { FoundServers } from './found-servers'

const log = createLogger('integrations', 'add-mcp-server-tool.ts')

/**
 * `add_mcp_server` (docs/plans/mcp-first-class.md §8.7): an agent that installed
 * an MCP server for its own CLI gives it to every agent. Solus reads the server
 * from the config files again and adds it through the same path as **Add** in
 * On your hosts, with the file's values. No card asks the person: they
 * told the agent to install it. A command starts once, so its tools are saved
 * for the next turn of Claude and Codex. A server that only a repository's
 * files hold is not added this way: a clone can hold any command.
 */

interface AddMcpServerDeps {
  found: Pick<FoundServers, 'list' | 'add'>
  /** `IntegrationGateway.startProcess`: the first start of a command, which saves its tools. */
  start(integrationId: string, starter: Principal): Promise<IntegrationFacts>
  /** `reportIntegrationConnection`: the sign-in or values card of a server that needs one. */
  askToConnect(integration: Integration, sessionId: string | undefined): Promise<AgentToolResult>
}

let deps: AddMcpServerDeps | null = null

/** Installed once at boot, beside the integration handlers; null leaves the tool unavailable. */
export function installAddMcpServerTool(next: AddMcpServerDeps | null): void {
  deps = next
}

/** A file in the repository: what a clone brings. `~/.claude.json` keeps its project entries in the person's own file. */
function isRepositoryPlace(place: FoundServer['foundIn'][number]): boolean {
  return place.kind === 'file' && place.scope === 'project' && place.file !== 'claude-json'
}

async function addMcpServer(name: string, cwd: string, sessionId: string | undefined): Promise<AgentToolResult> {
  const personKey = currentPersonKey()
  if (personKey === null) return { ok: false, text: 'An MCP server is added for a person, and this turn acts for none.' }
  if (!deps) return { ok: false, text: 'Integrations are not available on this host.' }
  const principal = workspaceToolAuthority() ?? INTERNAL_PRINCIPAL

  const list = await deps.found.list(principal, personKey, { projectPath: cwd, refresh: true })
  const matches = list.servers.filter((server) => server.foundIn.some((place) => place.kind === 'file' && place.name === name))
  if (matches.length === 0) {
    return { ok: false, text: `No MCP server named '${name}' is in the config files of Claude Code or Codex. Install it for your CLI first, for example with \`claude mcp add\` or \`codex mcp add\`, then call this tool again with the same name.` }
  }
  if (matches.length > 1) {
    return { ok: false, text: `Two config files have an MCP server named '${name}' with different commands or URLs. The user chooses one in Settings → MCP → On your hosts.` }
  }
  const server = matches[0]!
  if (server.state === 'added') return { ok: true, text: JSON.stringify({ name, alreadyAdded: true, note: `${name} is already in Solus. Claude and Codex both get its tools.` }) }
  if (server.foundIn.every(isRepositoryPlace)) {
    return { ok: false, text: `Only a file in the repository has '${name}', so Solus does not add it by itself. The user reads the command and adds it in Settings → MCP → On your hosts.` }
  }
  if (server.state === 'unsupported') return { ok: false, text: `${name} cannot be added. ${foundUnsupportedText(server.unsupported ?? 'invalid')}` }

  let result
  try {
    result = await deps.found.add(principal, personKey, { foundId: server.foundId, fingerprint: server.fingerprint, projectPath: cwd, useFileValues: true })
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
  if (result.kind !== 'saved') return { ok: false, text: `${name} changed in its file while Solus read it. Call this tool again.` }
  const { integration } = result
  log.info('integration_agent_added', { integrationId: integration.id, command: integration.launch !== undefined, needsValues: result.needsValues === true })

  // A server that needs a sign-in or values the file did not give: the person gives them in a card.
  if (result.needsValues || !integration.launch) return deps.askToConnect(integration, sessionId)
  const added = { name, added: true, projectOnly: server.projectOnly }
  try {
    await deps.start(integration.id, principal)
  } catch (error) {
    // The record stays: the person sees the error on its row and starts it again there.
    const message = error instanceof Error ? error.message : String(error)
    return { ok: true, text: JSON.stringify({ ...added, started: false, error: message, note: `${name} is added, but its first start failed. Tell the user; Settings → MCP shows the error.` }) }
  }
  return { ok: true, text: JSON.stringify({ ...added, started: true, note: `Claude and Codex get the tools of ${name} from the next turn.` }) }
}

export const addMcpServerAgentTool: AgentTool = {
  name: 'add_mcp_server',
  description:
    'Give an MCP server that you installed for your CLI to every agent in Solus. Call it after `claude mcp add`, `codex mcp add`, or an edit of a Claude Code or Codex config file, with the server\'s name as the file has it. Solus reads the file again, adds the server with the file\'s values, and starts a command once. Claude and Codex then get its tools from the next turn, and each tool shows once. A server that only a repository file has is not added: the user adds it in Settings → MCP.',
  inputFields: {
    name: z.string().trim().min(1).max(200).describe('The server\'s name in the config file, such as `opensearch`.'),
  } as const,
  // The user asked for the install; an add from the agent's own file asks nothing more.
  requiresApproval: false,
  execute: async (input, context) => addMcpServer(input.name, context.cwd, context.sessionId()),
}
