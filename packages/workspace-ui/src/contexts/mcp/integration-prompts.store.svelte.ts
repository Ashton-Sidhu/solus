import type { IntegrationPromptGetRequest, IntegrationPromptList, IntegrationPromptText } from '@solus/contracts/integrations/prompts'
import { serverConnections } from '@solus/client-core/server-connections'
import { HostProjectLists } from './host-project-lists.svelte'

/**
 * The MCP prompts of each host and project (docs/plans/mcp-first-class.md §10)
 * for the slash menu. A list is read when a composer opens the `/` menu and
 * kept: the menu shows the kept list at once and never waits on the network,
 * and a read happens once per opening, not per keystroke. `integration.changed`
 * (a server's list changed, a server was added or removed), a sign-in or a
 * sign-out, and a reconnect read the kept lists of that host again; the old
 * list shows until the new one lands.
 */
export class IntegrationPromptsStore extends HostProjectLists<IntegrationPromptList> {
  constructor() {
    super({
      read: (api, projectPath) => api.integrationPromptList(projectPath ? { projectPath } : {}),
      empty: { prompts: [], signIn: [] },
      rereadOn: ['integration.changed', 'integration.connectionChanged'],
    })
  }

  /** Expands one prompt on its host. The text is the person's next message. */
  expand(serverId: string, request: IntegrationPromptGetRequest): Promise<IntegrationPromptText> {
    return serverConnections.apiFor(serverId).integrationPromptGet(request)
  }
}
