/**
 * A view another surface asks the MCP page to show, such as the command
 * palette's "Find MCP servers on this host" (docs/plans/mcp-first-class.md
 * §8.6). Held outside the page, as `settingsHost` is, so the page takes it
 * when it mounts or while it is open. The page clears it once it shows it.
 */
class McpPageRequest {
  view = $state<'found' | null>(null)
}

export const mcpPageRequest = new McpPageRequest()
