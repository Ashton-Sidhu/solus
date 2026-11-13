import type { SessionArtifact } from '@solus/contracts/session-artifacts'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import type { WorkspaceContext } from '../../../../contexts/workspace/workspace.context.svelte'
import { projectRoot } from '../../../../contexts/workspace/run-location'
import { fileRouteParams } from './artifact-list'

type ArtifactOpener = Pick<WorkspaceContext, 'router' | 'prReview' | 'sessions' | 'ctx' | 'ctxForDirectory' | 'serverIdForSession'>

/**
 * Open one artifact as its own surface, with the route that already shows that
 * kind of record. `ownerSessionId` is the session that linked it: its project
 * scopes a pull request and holds a file, and its host holds every item (a
 * file, automation, or app link is refused unless it is on the session's host).
 * A caller that knows the host passes it: a session with no tab here does not.
 */
export function openArtifact(
  workspace: ArtifactOpener,
  artifact: SessionArtifact,
  ownerSessionId: string,
  serverId = workspace.serverIdForSession(ownerSessionId),
): void {
  const root = projectRoot(workspace.sessions.byId[ownerSessionId]?.run)
  switch (artifact.kind) {
    case 'pull-request': {
      const { link } = artifact
      void workspace.prReview.openPullRequest(
        {
          number: link.number,
          title: link.title || undefined,
          url: link.url,
          expectedRepo: parseGitHubPullRequestUrl(link.url)?.baseRepo,
        },
        { ctx: root ? workspace.ctxForDirectory(root) : workspace.ctx, serverId, via: 'click' },
      )
      return
    }
    case 'work':
      workspace.router.navigate({ name: 'work', params: { workId: artifact.workId, serverId } })
      return
    case 'file':
    case 'image':
      workspace.router.navigate({
        name: 'files',
        params: fileRouteParams(artifact, serverId, root),
      })
      return
    case 'automation':
      workspace.router.navigate({
        name: 'automation',
        params: { automationId: artifact.automationId, serverId },
      })
      return
    case 'app':
      workspace.router.navigate(
        { name: 'app', params: { slug: artifact.slug, serverId } },
        { target: 'companion' },
      )
  }
}
