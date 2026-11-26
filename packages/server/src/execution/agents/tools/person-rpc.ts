import type { SolusAPI } from '@solus/contracts/host-api'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import type { AgentToolContext, AgentToolResult } from './agent-tool'
import { projectToolHost, type ProjectToolCaller } from './project-tools'

/** The RPCs of the project, codebase, sharing, and host tools: the ones Settings, the project chip, the Share dialog, the host page, and mobile send. */
export type PersonRpcMethod =
  | 'listProjects' | 'projectConfigLoad' | 'projectConfigSave' | 'untrackProject'
  | 'codebaseList' | 'codebaseSave' | 'codebaseMembers' | 'codebaseScanFolder'
  | 'shareGet' | 'shareSet' | 'shareSetLink' | 'shareLinkOrigin'
  | 'hostSelfTest' | 'hostResources'

/** `SolusServer.handle` for each of these methods: the access gate and the handler that a client's call gets. */
export type PersonRpcHost = { [M in PersonRpcMethod]: (args: Parameters<SolusAPI[M]>, caller: ProjectToolCaller) => ReturnType<SolusAPI[M]> }

/** One RPC as the person of the turn sends it from a client. */
export type PersonCall = <M extends PersonRpcMethod>(method: M, ...args: Parameters<SolusAPI[M]>) => ReturnType<SolusAPI[M]>

/**
 * Run one tool call as the person the turn works for. A guest's turn is
 * refused where the guest's client is refused, and a member's turn reads and
 * changes only what the member can from a client. A turn with no person, a
 * host with no server, and a refused or failed call answer an error result.
 */
export async function asPerson(toolName: string, context: AgentToolContext, run: (call: PersonCall) => Promise<AgentToolResult>): Promise<AgentToolResult> {
  const principal = workspaceToolAuthority()
  if (!principal) return { ok: false, text: `${toolName} requires an admitted Solus turn.` }
  const bound = projectToolHost()?.rpc
  if (!bound) return { ok: false, text: `${toolName} is not available on this host.` }
  const caller: ProjectToolCaller = { principal, clientId: `agent:${context.sessionId() ?? context.provider}`, abortSignal: context.abortSignal }
  try {
    return await run((method, ...args) => bound[method](args, caller))
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}
