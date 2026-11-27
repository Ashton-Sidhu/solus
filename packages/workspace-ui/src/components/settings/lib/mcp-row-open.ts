/**
 * Whether an installed server's row on the MCP page shows its details. A
 * running sign-in opens the row by itself, so the person sees it, but the
 * person's own close wins: a sign-in that waits for a page that never answers
 * must not hold the row open.
 */
export function mcpRowIsOpen(state: { isExpanded: boolean; isSignInRunning: boolean; isClosedByPerson: boolean }): boolean {
  return state.isExpanded || (state.isSignInRunning && !state.isClosedByPerson)
}
