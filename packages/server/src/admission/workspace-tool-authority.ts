import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResourceRole, ShareResource } from '@solus/contracts/sharing'
import type { Principal } from './principal'
import { assertRpcAccess, type ResourceAccess } from './access-policy'

/** Set at admitted turn execution, never from model-supplied tool arguments. */
const authority = new AsyncLocalStorage<Principal>()
export function withWorkspaceToolAuthority<T>(principal: Principal, run: () => T): T { return authority.run(principal, run) }
export function workspaceToolAuthority(): Principal | undefined { return authority.getStore() }

let roleOfResource: ((principal: Principal, resource: ShareResource) => Promise<ResourceRole>) | null = null
let resourceAccess: ResourceAccess | null = null

/** Boot gives the agent tools the share manager's role check, and its standing reads for the RPC rules. */
export function installToolAccess(roleFor: (principal: Principal, resource: ShareResource) => Promise<ResourceRole>, resources: ResourceAccess): void {
  roleOfResource = roleFor
  resourceAccess = resources
}

/**
 * The commands an agent tool sends to the runtime of this host, each as the RPC
 * a person's client sends for it, with the arguments that name its session.
 */
const COMMAND_ARGS = {
  createHeadlessSession: (): unknown[] => [],
  promptHeadlessSession: (sessionId: string): unknown[] => [{ sessionId }],
  stopSession: (sessionId: string): unknown[] => [sessionId],
  sessionQueue: (sessionId: string): unknown[] => [{ session: { sessionId } }],
  sessionQueueChange: (sessionId: string): unknown[] => [{ session: { sessionId } }],
  rateLimitDecision: (sessionId: string): unknown[] => [{ session: { sessionId } }],
  forkSessionFromResponse: (sessionId: string): unknown[] => [{ sessionId }],
  setSessionTitle: (sessionId: string): unknown[] => [sessionId],
}
export type ToolCommand = keyof typeof COMMAND_ARGS

/**
 * Refuses a command that the person of the turn could not send from a client:
 * the same RPC rules, for the same session. A member's or a guest's turn acts
 * only where that person may act. The host's own work, with no person, may do
 * everything, as it may read everything (plans/031 rule 1).
 */
export async function assertToolMay(command: ToolCommand, sessionId = ''): Promise<void> {
  const principal = workspaceToolAuthority()
  if (!principal) return
  await assertRpcAccess(command, principal, COMMAND_ARGS[command](sessionId), resourceAccess ?? undefined)
}

/**
 * Whether the turn running an agent tool may read a record: a member's or a guest's
 * turn reads only what the person may open. The host's own work, and the host's
 * owner, read everything on the disk (plans/031 rule 1).
 */
export async function toolMayRead(resource: ShareResource): Promise<boolean> {
  const principal = workspaceToolAuthority()
  if (!principal || !roleOfResource) return true
  return (await roleOfResource(principal, resource)) !== 'none'
}
