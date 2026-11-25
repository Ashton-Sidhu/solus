import { hosts } from '../../contexts/hosts/hosts.svelte'
import { openChatDraft } from '../../contexts/workspace/new-chat'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'
import type { FleetMachine } from './lib/fleet-model'
import { hostAgentPrompt, hostToAskOn, type HostAsk } from './lib/host-agent'

/**
 * "Ask an agent": a new chat about these hosts,
 * with its prompt ready for the person to read and send. It runs on the host
 * itself when that host answers, else on this device.
 */
export function askAgentAboutHosts(
  workspace: Pick<WorkspaceContext, 'drafts' | 'router'>,
  machines: readonly FleetMachine[],
  ask: HostAsk,
): void {
  if (machines.length === 0) return
  openChatDraft(workspace, 'click', { serverId: hostToAskOn(machines, hosts.device?.id), prompt: hostAgentPrompt(machines, ask) })
}
