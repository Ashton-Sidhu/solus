/**
 * A request for the MCP page from outside it, held outside the page as
 * `settingsHost` is, so the page takes it when it mounts or while it is open:
 * the command palette's "Add an MCP server" (docs/plans/mcp-first-class.md
 * §7.7) and the connect card's command (which only Settings adds) open the
 * add dialog once, and "Find MCP servers on your hosts" (§8.6)
 * asks for a view, which the page clears once it shows it.
 */
class McpPageRequest {
  isAddServerAsked = $state(false)
  view = $state<'found' | null>(null)
  /** What the add dialog's one field starts with, such as a command the connect card could not add. */
  private addServerSource = ''

  askAddServer(source = ''): void {
    this.addServerSource = source
    this.isAddServerAsked = true
  }

  /** The ask, once for each: the text the dialog's field starts with. */
  takeAddServer(): { source: string } | null {
    if (!this.isAddServerAsked) return null
    this.isAddServerAsked = false
    const source = this.addServerSource
    this.addServerSource = ''
    return { source }
  }
}

export const mcpPageRequest = new McpPageRequest()
