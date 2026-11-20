/**
 * A request for the MCP page from outside it, held outside the page as
 * `settingsHost` is, so the page takes it when it mounts or while it is open:
 * the command palette's "Add an MCP server command" (docs/plans/mcp-first-class.md
 * §7.7) opens the command form once, and "Find MCP servers on this host" (§8.6)
 * asks for a view, which the page clears once it shows it.
 */
class McpPageRequest {
  isAddCommandAsked = $state(false)
  view = $state<'found' | null>(null)

  askAddCommand(): void {
    this.isAddCommandAsked = true
  }

  /** True once for each ask. */
  takeAddCommand(): boolean {
    const asked = this.isAddCommandAsked
    this.isAddCommandAsked = false
    return asked
  }
}

export const mcpPageRequest = new McpPageRequest()
