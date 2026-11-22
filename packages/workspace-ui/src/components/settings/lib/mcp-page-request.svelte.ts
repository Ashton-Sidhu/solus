/**
 * A request for the MCP page from outside it, held outside the page as
 * `settingsHost` is, so the page takes it when it mounts or while it is open:
 * the command palette's "Add an MCP server" (docs/plans/mcp-first-class.md
 * §7.7) opens the add dialog once, and "Find MCP servers on your hosts" (§8.6)
 * asks for a view, which the page clears once it shows it.
 */
class McpPageRequest {
  isAddServerAsked = $state(false)
  view = $state<'found' | null>(null)

  askAddServer(): void {
    this.isAddServerAsked = true
  }

  /** True once for each ask. */
  takeAddServer(): boolean {
    const asked = this.isAddServerAsked
    this.isAddServerAsked = false
    return asked
  }
}

export const mcpPageRequest = new McpPageRequest()
