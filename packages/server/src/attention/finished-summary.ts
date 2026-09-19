import type { SessionMeta } from '@solus/contracts/types'

/** Keep completion context short enough for a toast on a phone. */
export function finishedSummary(
  session: Pick<SessionMeta, 'customTitle' | 'slug' | 'firstMessage'> | null,
  projectKey?: string,
): string {
  const title = [session?.customTitle, session?.slug, session?.firstMessage]
    .find((value) => value?.trim())
  const project = projectKey?.split(/[\\/]/).filter(Boolean).at(-1)
  const summary = (title || project || 'Your session has finished.').replace(/\s+/g, ' ').trim()
  return summary.length > 160 ? `${summary.slice(0, 157).trimEnd()}…` : summary
}
