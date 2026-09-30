import type { Via } from '@solus/contracts/analytics-events'
import { cloudAccount } from '@solus/client-core/cloud-account'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostIsManaged } from '../../components/servers/lib/managed-host'
import { requestInputFocus } from '../../lib/inputFocus'
import { toasts } from '../../lib/toasts'
import { connectionsStore } from '../connections/connections.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { chooseChatHost } from '../projects/chat-host-rule'
import type { WorkspaceContext } from './workspace.context.svelte'

type JustChatWorkspace = Pick<WorkspaceContext, 'drafts' | 'router' | 'settings'>

/**
 * "Just chat": a new draft in Scratchpad, in the leading pane, with the caret
 * in its composer (docs/projects.md, "Scratchpad"). The host follows the S6
 * rule in `chooseChatHost`; the chat folder is the one that host names.
 */
export async function openScratchpadDraft(workspace: JustChatWorkspace, via: Via = 'palette'): Promise<void> {
  const serverId = chooseChatHost(
    serversStore.executionServers.map((host) => ({
      serverId: host.id,
      online: host.status === 'online',
      managed: hostIsManaged(host),
      local: host.local,
    })),
    {
      atCloudOrigin: cloudAccount() !== null,
      lastChatServerId: workspace.settings.lastChatServerId,
      // A chat runs on a machine: the window's own host is the workspace service at the account origin.
      defaultServerId: serverConnections.defaultMachineId(),
    },
  )
  if (!serverId) {
    toasts.error('Scratchpad is not available', { description: 'No connected host can run a chat.' })
    return
  }
  if (!connectionsStore.capabilitiesFor(serverId)) await connectionsStore.refreshCapabilities({ serverId })
  const chatFolder = connectionsStore.chatFolderFor(serverId)
  if (!chatFolder) {
    const hostLabel = serversStore.hostFor(serverId)?.label ?? serverId
    toasts.error('Scratchpad is not available', { description: `${hostLabel} does not offer Scratchpad right now.` })
    return
  }
  workspace.drafts.openSessionDraft(
    { freshTask: true, serverId, target: workspace.router.leadingPane.id, via },
    chatFolder,
  )
  requestInputFocus()
}
