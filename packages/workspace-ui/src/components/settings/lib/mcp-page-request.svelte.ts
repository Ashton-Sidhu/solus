/**
 * A request for the MCP page from outside it: the command palette's "Add an
 * MCP server command" (docs/plans/mcp-first-class.md §7.7). The page that
 * shows takes it once and opens the command form.
 */
class McpPageRequest {
  isAddCommandAsked = $state(false)

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
