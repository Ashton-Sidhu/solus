import type { GeneratedQuery } from './insights-queries'

/**
 * Open Insights already asking one question: every turn of a session, or of
 * every session that worked a task. The scope is the question, not the route —
 * the page renders whatever the store last asked, exactly as it does for a
 * preset or a typed statement.
 *
 * The query store loads here, when a person asks, rather than with the menus
 * and the workspace that offer the question. The question is recorded before
 * the page opens, so the page's opening load re-asks this one instead of the
 * previous one.
 *
 * `metrics.db` is host-local and the page follows the active host, so a
 * session recorded on another host answers empty. The entry points offer this
 * only for the active host's own sessions.
 */
export async function askInsights(query: GeneratedQuery, openPage: () => void): Promise<void> {
  const { insightsStore } = await import('../insights.store.svelte')
  void insightsStore.runGenerated(query)
  openPage()
}
