import { IntegrationPromptsStore } from './integration-prompts.store.svelte'
import { IntegrationResourceListsStore } from './integration-resource-lists.svelte'
import { IntegrationsStore } from './integrations.store.svelte'

/**
 * The MCP state of this client on desktop and web (docs/plans/mcp-first-class.md):
 * one owner, with one sub-owner for each kind of record.
 *
 * The first screen does not import this module: the app loads it after the
 * first paint (`app-core.ts`), and the settings, the conversation, and the
 * composer menus load it with their own code. The chips of attached resources
 * are on the first screen, so they are `resourceAttachments`, apart from it.
 */
class McpStore {
  /** The integrations of each host, their tools, facts, command processes, and the caller's connections and sign-ins. */
  readonly integrations = new IntegrationsStore()
  /** The MCP prompt lists of each host and project, for the `/` menu. */
  readonly prompts = new IntegrationPromptsStore()
  /** The MCP resource lists of each host and project, for the `@` menu. */
  readonly resources = new IntegrationResourceListsStore()
}

export const mcpStore = new McpStore()
