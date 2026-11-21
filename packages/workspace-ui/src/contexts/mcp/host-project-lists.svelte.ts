import { SvelteMap } from 'svelte/reactivity'
import type { IntegrationResourceLists } from '@solus/contracts/integration-types'
import type { IntegrationPromptGetRequest, IntegrationPromptList, IntegrationPromptText } from '@solus/contracts/integrations/prompts'
import { HostProjectLists, type HostListsSource } from '@solus/client-core/host-project-lists'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * The MCP lists of each host and project on this client: the client-core
 * `HostProjectLists` on this client's hosts, kept in `SvelteMap`s so a menu
 * that reads one list wakes for that list only.
 */
const source: HostListsSource = {
  connection: (serverId) => ({ api: serverConnections.apiFor(serverId), events: serverConnections.eventsFor(serverId) }),
  watchReconnects: (serverId, reconnected) => serverConnections.onReadinessChange((hostId, readiness) => {
    if (hostId === serverId && readiness === 'ready') reconnected()
  }),
  onForgotten: (forgotten) => hostCatalog.onForgotten((host) => forgotten(host.id)),
}

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
      source,
      map: () => new SvelteMap(),
    })
  }

  /** Expands one prompt on its host. The text is the person's next message. */
  expand(serverId: string, request: IntegrationPromptGetRequest): Promise<IntegrationPromptText> {
    return serverConnections.apiFor(serverId).integrationPromptGet(request)
  }
}

/**
 * The caller's MCP resources on each host, for the `@` menu
 * (docs/plans/mcp-first-class.md §11.3, §11.4). A list is read when the menu
 * first opens for a host and project, never for a keystroke: the menu matches
 * on what is here. `integration.changed` and a reconnect read the host's kept
 * lists again, so a list-changed notification on the server reaches the menu.
 * A host that cannot list, or fails, has no section.
 */
export class IntegrationResourceListsStore extends HostProjectLists<IntegrationResourceLists> {
  constructor() {
    super({
      // An older host has no `integrationResourceList`, and a failed list shows no section (§11.4).
      read: (api, projectPath) => api.integrationResourceList(projectPath ? { projectPath } : {}),
      empty: { resources: [], templates: [] },
      rereadOn: ['integration.changed'],
      source,
      map: () => new SvelteMap(),
    })
  }
}
