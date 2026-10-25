// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestEnvironmentFallback.ts (MIT, see UPSTREAM.md).
import { useEffect, useMemo } from 'react'
import { useApp, useListened } from '../../app/app-context'
import { pullRequestFallbackHost } from './lib/pull-request-host-fallback'
import type { PullRequestRef } from './pull-request-directory'

/**
 * Moves a pull request route to a connected host with a checkout of the same
 * repository while the route's own host is not connected. Review drafts are
 * kept for each host, so a draft started on the first host does not follow.
 */
export function usePullRequestHostFallback(
  ref: PullRequestRef,
  repositoryKey: string | null,
  move: (target: { hostId: string; projectPath: string }) => void,
): void {
  const app = useApp()
  const projects = useListened(app.threads.changes, app.threads.projects)
  const checkouts = useMemo(
    () => projects.map((shell) => ({ hostId: shell.hostId, projectPath: shell.project.path, repositoryKey: shell.project.repositoryKey })),
    [projects],
  )
  // A string, so an unchanged set of connected hosts does not compute again.
  const connectedKey = useListened(app.connections.changes, () =>
    Array.from(new Set(checkouts.map((checkout) => checkout.hostId)))
      .filter((hostId) => app.connections.state(hostId)?.readiness === 'ready')
      .join('\u0000'))
  const fallback = useMemo(
    () => pullRequestFallbackHost(ref, repositoryKey, checkouts, new Set(connectedKey.split('\u0000'))),
    [ref, repositoryKey, checkouts, connectedKey],
  )
  useEffect(() => {
    if (fallback) move(fallback)
  }, [fallback, move])
}
