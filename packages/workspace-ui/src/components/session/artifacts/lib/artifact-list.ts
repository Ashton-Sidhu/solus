import {
  allSessionArtifacts,
  type FileArtifact,
  type SessionArtifact,
  type SessionArtifactKind,
  type SessionArtifacts,
} from '@solus/contracts/session-artifacts'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import type { WorkType } from '@solus/contracts/types'
import { hostPathBaseName, relativeHostPath, trimTrailingSeparators } from '@solus/contracts/host-path'
import type { RouteParams } from '../../../../contexts/workspace/routing/route-registry'
import { artifactLinkedAt } from '../../../../contexts/sessions/session-artifacts'

/** Which artifacts the list shows: all of them, or one kind. */
export type ArtifactFilter = 'all' | SessionArtifactKind

export interface ArtifactFilterChip {
  filter: ArtifactFilter
  label: string
  count: number
}

/** One titled run of rows. */
export interface ArtifactSection {
  key: string
  title: string
  items: SessionArtifact[]
}

const KIND_ORDER: readonly SessionArtifactKind[] = ['pull-request', 'work', 'file', 'image', 'automation']

const CHIP_LABELS = {
  'pull-request': 'PRs',
  work: 'Works',
  file: 'Files',
  image: 'Images',
  automation: 'Automations',
} satisfies { [Kind in SessionArtifactKind]: string }

const SECTION_TITLES = {
  'pull-request': 'Pull requests',
  work: 'Works',
  file: 'Files',
  image: 'Images',
  automation: 'Automations',
} satisfies { [Kind in SessionArtifactKind]: string }

const KIND_LABELS = {
  'pull-request': 'Pull request',
  file: 'File',
  image: 'Image',
  automation: 'Automation',
} satisfies { [Kind in Exclude<SessionArtifactKind, 'work'>]: string }

const WORK_TYPE_LABELS = {
  doc: 'Doc',
  slides: 'Slides',
  diagram: 'Diagram',
  artifact: 'Artifact',
} satisfies { [Type in WorkType]: string }

function newestFirst(items: readonly SessionArtifact[]): SessionArtifact[] {
  return items.slice().sort((a, b) => artifactLinkedAt(b) - artifactLinkedAt(a))
}

function matches(filter: ArtifactFilter, query: string, artifact: SessionArtifact): boolean {
  return (filter === 'all' || artifact.kind === filter) && artifactMatchesQuery(artifact, query)
}

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

/** All, then one chip per kind the list holds. A kind with no items has no chip. */
export function filterChips(artifacts: SessionArtifacts): ArtifactFilterChip[] {
  const all = allSessionArtifacts(artifacts)
  const chips: ArtifactFilterChip[] = [{ filter: 'all', label: 'All', count: all.length }]
  for (const kind of KIND_ORDER) {
    const count = all.filter((artifact) => artifact.kind === kind).length
    if (count > 0) chips.push({ filter: kind, label: CHIP_LABELS[kind], count })
  }
  return chips
}

/** A filter whose kind no longer has items falls back to All. */
export function effectiveFilter(filter: ArtifactFilter, chips: readonly ArtifactFilterChip[]): ArtifactFilter {
  return chips.some((chip) => chip.filter === filter) ? filter : 'all'
}

/**
 * The sections the list shows, newest first inside each. A session that started
 * no other session groups its rows by kind. A lead shows its own rows as "This
 * session", then one section per session it started, titled by that session's
 * name. A section with no rows under the filter and the search is left out.
 */
export function artifactSections(artifacts: SessionArtifacts, filter: ArtifactFilter, query = ''): ArtifactSection[] {
  if (artifacts.children.length === 0) {
    return KIND_ORDER.filter((kind) => filter === 'all' || filter === kind)
      .map((kind) => ({
        key: `kind:${kind}`,
        title: SECTION_TITLES[kind],
        items: newestFirst(artifacts.own.filter((artifact) => artifact.kind === kind && artifactMatchesQuery(artifact, query))),
      }))
      .filter((section) => section.items.length > 0)
  }
  const sections: ArtifactSection[] = [
    { key: 'own', title: 'This session', items: newestFirst(artifacts.own.filter((artifact) => matches(filter, query, artifact))) },
    ...artifacts.children.map((group) => ({
      key: `session:${group.sessionId}`,
      title: group.title?.trim() || 'Untitled session',
      items: newestFirst(group.items.filter((artifact) => matches(filter, query, artifact))),
    })),
  ]
  return sections.filter((section) => section.items.length > 0)
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
 * image is in. A work or an automation is named by its title alone.
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

