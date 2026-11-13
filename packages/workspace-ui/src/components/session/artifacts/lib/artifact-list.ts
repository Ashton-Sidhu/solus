import type { FileArtifact, SessionArtifact, SessionArtifactKind } from '@solus/contracts/session-artifacts'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import type { WorkType } from '@solus/contracts/types'
import { hostPathBaseName, relativeHostPath, trimTrailingSeparators } from '@solus/contracts/host-path'
import type { RouteParams } from '../../../../contexts/workspace/routing/route-registry'

const KIND_LABELS = {
  'pull-request': 'Pull request',
  file: 'File',
  image: 'Image',
  automation: 'Automation',
  app: 'App',
} satisfies { [Kind in Exclude<SessionArtifactKind, 'work'>]: string }

const WORK_TYPE_LABELS = {
  doc: 'Doc',
  slides: 'Slides',
  artifact: 'Artifact',
} satisfies { [Type in WorkType]: string }

/**
 * Whether the search finds the artifact: the query, without case, inside its
 * name, its full path or pull request reference, or its kind. An empty query
 * finds everything.
 */
export function artifactMatchesQuery(artifact: SessionArtifact, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [artifactTitle(artifact), artifactTooltip(artifact), artifactKindLabel(artifact)].some((text) =>
    text.toLowerCase().includes(needle),
  )
}

/** The row's name. A file goes by its base name. */
export function artifactTitle(artifact: SessionArtifact): string {
  switch (artifact.kind) {
    case 'pull-request':
      return artifact.link.title || `#${artifact.link.number}`
    case 'file':
    case 'image':
      return hostPathBaseName(artifact.path) || artifact.title
    case 'work':
    case 'automation':
    case 'app':
      return artifact.title || 'Untitled'
  }
}

/** The full name the row's tooltip gives: a file's whole path. */
export function artifactTooltip(artifact: SessionArtifact): string {
  switch (artifact.kind) {
    case 'pull-request':
      return `${artifact.link.repository}#${artifact.link.number}${artifact.link.title ? ` · ${artifact.link.title}` : ''}`
    case 'file':
    case 'image':
      return artifact.path
    case 'work':
    case 'automation':
    case 'app':
      return artifactTitle(artifact)
  }
}

/** Where a pull request stands, as PR sync last saw it. Null before it answers. */
export type PullRequestArtifactState = 'open' | 'draft' | 'merged' | 'closed' | 'missing'

export function pullRequestState(link: SessionPullRequestLink): PullRequestArtifactState | null {
  if (link.missing) return 'missing'
  const snapshot = link.snapshot
  if (!snapshot) return null
  if (snapshot.state === 'open' && snapshot.draft) return 'draft'
  return snapshot.state
}

/** What the artifact is: "Pull request", a work's type, "File". */
export function artifactKindLabel(artifact: SessionArtifact): string {
  return artifact.kind === 'work' ? WORK_TYPE_LABELS[artifact.workType] : KIND_LABELS[artifact.kind]
}

const PULL_REQUEST_STATE_LABELS = {
  open: 'Open pull request',
  draft: 'Draft pull request',
  merged: 'Merged pull request',
  closed: 'Closed pull request',
  missing: 'Pull request not found',
} satisfies { [State in PullRequestArtifactState]: string }

/** What the row's icon stands for, said in words for its tooltip and screen readers. */
export function artifactIconLabel(artifact: SessionArtifact): string {
  if (artifact.kind !== 'pull-request') return artifactKindLabel(artifact)
  const state = pullRequestState(artifact.link)
  return state ? PULL_REQUEST_STATE_LABELS[state] : KIND_LABELS['pull-request']
}

/**
 * The row's muted line after the title: where a pull request lives, the folder a file or
 * image is in. A work, an automation, or an app is named by its title alone.
 */
export function artifactDetail(artifact: SessionArtifact): string | null {
  switch (artifact.kind) {
    case 'pull-request':
      return `${artifact.link.repository} #${artifact.link.number}`
    case 'file':
    case 'image': {
      const path = trimTrailingSeparators(artifact.path)
      const folder = trimTrailingSeparators(path.slice(0, path.length - hostPathBaseName(path).length))
      return folder || null
    }
    case 'work':
    case 'automation':
    case 'app':
      return null
  }
}

/**
 * The Files surface for a linked file: the session's project with the file
 * open when the file is inside it, else the file's own folder.
 */
/** A file link is always on the session's execution host (the host refuses
 *  any other), so it opens on the session's connection, `serverId`; the link's
 *  `hostId` is that machine's id, not a connection. */
export function fileRouteParams(artifact: FileArtifact, serverId: string, projectRoot: string | null): RouteParams['files'] {
  const relative = projectRoot ? relativeHostPath(projectRoot, artifact.path) : null
  if (projectRoot && relative) return { serverId, cwd: projectRoot, path: relative }
  const path = trimTrailingSeparators(artifact.path)
  const name = hostPathBaseName(path)
  const folder = trimTrailingSeparators(path.slice(0, path.length - name.length)) || path.slice(0, 1) || '/'
  return { serverId, cwd: folder, path: name }
}

