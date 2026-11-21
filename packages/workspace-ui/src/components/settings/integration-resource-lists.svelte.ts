import type { IntegrationResourceLists } from '@solus/contracts/integration-types'
import { HostProjectLists } from '../../lib/host-project-lists.svelte'

/**
 * The caller's MCP resources on each host, for the `@` menu
 * (docs/plans/mcp-first-class.md §11.3, §11.4). A list is read when the menu
 * first opens for a host and project, never for a keystroke: the menu matches
 * on what is here. `integration.changed` and a reconnect read the host's kept
 * lists again, so a list-changed notification on the server reaches the menu.
 * A host that cannot list, or fails, has no section.
 */
export const integrationResourceLists = new HostProjectLists<IntegrationResourceLists>({
  // An older host has no `integrationResourceList`, and a failed list shows no section (§11.4).
  read: (api, projectPath) => api.integrationResourceList(projectPath ? { projectPath } : {}),
  empty: { resources: [], templates: [] },
  rereadOn: ['integration.changed'],
})
