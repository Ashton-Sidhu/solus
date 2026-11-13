/**
 * Whether a deploy opens the app's surface (docs/plans/apps.md §9): only
 * beside the conversation that made it, while that conversation is the
 * destination. `leading` is the session in the leading pane and the host that
 * runs it; null when a page or a draft leads.
 */
export function opensBesideConversation(
  deploy: { serverId: string; sessionId: string },
  leading: { sessionId: string; serverId: string } | null,
): boolean {
  return leading !== null && leading.sessionId === deploy.sessionId && leading.serverId === deploy.serverId
}
