import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { PermissionMode } from '@solus/contracts/types'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { RunToolBinding } from '@solus/server/execution/agents/tools/agent-tool-endpoint'

/**
 * An MCP client connected to a run's tools as the host's endpoint serves them:
 * what any harness lists and calls (plans/035 §3).
 */
export async function runToolClient(
  tools: AgentTool[],
  context: Omit<AgentToolContext, 'parentToolUseId'>,
  permissionMode: PermissionMode = 'supervised',
  approve: RunToolBinding['approve'] = async () => true,
): Promise<Client> {
  // Loaded on use: a test mocks node:sqlite before the server's modules load.
  const { runToolServer } = await import('@solus/server/execution/agents/tools/agent-tool-endpoint')
  const server = runToolServer({ tools, context, permissionMode: () => permissionMode, approve })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  return client
}
