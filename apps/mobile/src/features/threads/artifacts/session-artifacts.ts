import type { WorkType } from '@solus/contracts/types'
import type { AppSymbolName } from '../../../components/AppSymbol'
import { allSessionArtifacts, type SessionArtifact, type SessionArtifactKind, type SessionArtifacts } from '@solus/contracts/session-artifacts'

/**
 * What the Artifacts screen shows (docs/plans/session-artifacts.md): the
 * filter chips, and the sections of the list for one filter. A plain session
 * groups its items by kind; a session that started others shows its own items
 * first, then one section per session it started.
 */

export type ArtifactFilter = 'all' | SessionArtifactKind

const KIND_ORDER: readonly SessionArtifactKind[] = ['pull-request', 'work', 'file', 'image', 'automation']

const FILTER_LABEL = {
  all: 'All',
  'pull-request': 'PRs',
  work: 'Works',
  file: 'Files',
  image: 'Images',
  automation: 'Automations',
} satisfies Record<ArtifactFilter, string>

const KIND_TITLE = {
  'pull-request': 'Pull requests',
  work: 'Works',
  file: 'Files',
  image: 'Images',
  automation: 'Automations',
} satisfies Record<SessionArtifactKind, string>

const WORK_TYPE_LABEL = {
  doc: 'Document',
  slides: 'Slides',
  diagram: 'Diagram',
  artifact: 'Artifact',
} satisfies Record<WorkType, string>

export interface ArtifactFilterChip {
  readonly filter: ArtifactFilter
  readonly label: string
  readonly count: number
}

export interface ArtifactSection {
  readonly key: string
  readonly title: string
  readonly items: readonly SessionArtifact[]
}

/** All, then each kind the list holds, in a fixed order. A kind with no items has no chip. */
export function artifactFilterChips(artifacts: SessionArtifacts): ArtifactFilterChip[] {
  const items = allSessionArtifacts(artifacts)
  const chips: ArtifactFilterChip[] = [{ filter: 'all', label: FILTER_LABEL.all, count: items.length }]
  for (const kind of KIND_ORDER) {
    const count = items.filter((item) => item.kind === kind).length
    if (count > 0) chips.push({ filter: kind, label: FILTER_LABEL[kind], count })
  }
  return chips
}

/**
 * Whether the search finds the item: the query, without case, inside its
 * title, its path or pull request reference, or what its icon stands for.
 * An empty query finds everything.
 */
export function artifactMatchesQuery(item: SessionArtifact, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const text = artifactRowText(item)
  return [text.title, text.detail ?? '', text.iconLabel].some((value) => value.toLowerCase().includes(needle))
}

/** The sections for one filter and search. A section with nothing to show is left out. */
export function artifactSections(artifacts: SessionArtifacts, filter: ArtifactFilter, query = ''): ArtifactSection[] {
  const shown = (items: readonly SessionArtifact[]) =>
    items.filter((item) => (filter === 'all' || item.kind === filter) && artifactMatchesQuery(item, query))
  if (artifacts.children.length === 0) {
    return KIND_ORDER
      .map((kind) => ({ key: kind, title: KIND_TITLE[kind], items: shown(artifacts.own).filter((item) => item.kind === kind) }))
      .filter((section) => section.items.length > 0)
  }
  return [
    { key: 'own', title: 'This session', items: shown(artifacts.own) },
    ...artifacts.children.map((child) => ({ key: child.sessionId, title: child.title ?? 'Untitled session', items: shown(child.items) })),
  ].filter((section) => section.items.length > 0)
}

/** A key that names one item in its section. */
export function artifactKey(item: SessionArtifact): string {
  switch (item.kind) {
    case 'pull-request': return `pr:${item.link.url}`
    case 'work': return `work:${item.workId}`
    case 'file':
    case 'image': return `${item.kind}:${item.hostId}:${item.path}`
    case 'automation': return `automation:${item.hostId}:${item.automationId}`
  }
}

/**
 * A row's title, the line under it, and what its icon stands for. The icon
 * carries the kind and the state, so the line under the title names only
 * where the item lives; a work or an automation has no such line.
 */
export interface ArtifactRowText {
  readonly title: string
  readonly detail: string | null
  readonly iconLabel: string
}

const PULL_REQUEST_STATE_LABEL = {
  open: 'Open pull request',
  draft: 'Draft pull request',
  merged: 'Merged pull request',
  closed: 'Closed pull request',
  missing: 'Pull request not found',
} satisfies Record<PullRequestState, string>

export function artifactRowText(item: SessionArtifact): ArtifactRowText {
  switch (item.kind) {
    case 'pull-request': {
      const state = pullRequestState(item)
      return {
        title: item.link.title || `#${item.link.number}`,
        detail: `${item.link.repository} #${item.link.number}`,
        iconLabel: state ? PULL_REQUEST_STATE_LABEL[state] : 'Pull request',
      }
    }
    case 'work': return { title: item.title, detail: null, iconLabel: WORK_TYPE_LABEL[item.workType] }
    case 'file': return { title: item.title, detail: item.path, iconLabel: 'File' }
    case 'image': return { title: item.title, detail: item.path, iconLabel: 'Image' }
    case 'automation': return { title: item.title, detail: null, iconLabel: 'Automation' }
  }
}

/** Where a pull request stands, as PR sync last saw it. Null before it answers. */
type PullRequestState = 'open' | 'draft' | 'merged' | 'closed' | 'missing'

function pullRequestState(item: Extract<SessionArtifact, { kind: 'pull-request' }>): PullRequestState | null {
  if (item.link.missing) return 'missing'
  const snapshot = item.link.snapshot
  if (!snapshot) return null
  return snapshot.state === 'open' && snapshot.draft ? 'draft' : snapshot.state
}

const WORK_TYPE_ICON = {
  doc: 'doc.text',
  slides: 'square.on.square',
  diagram: 'point.3.connected.trianglepath.dotted',
  artifact: 'chevron.left.forwardslash.chevron.right',
} satisfies Record<WorkType, AppSymbolName>

const PULL_REQUEST_ICON = {
  open: 'arrow.triangle.pull',
  draft: 'arrow.triangle.pull',
  merged: 'arrow.triangle.merge',
  closed: 'xmark.circle.fill',
  missing: 'exclamationmark.triangle',
} satisfies Record<PullRequestState, AppSymbolName>

/** The row's icon: a work's type, a pull request's state, else the kind. */
export function artifactIcon(item: SessionArtifact): AppSymbolName {
  switch (item.kind) {
    case 'pull-request': return PULL_REQUEST_ICON[pullRequestState(item) ?? 'open']
    case 'work': return WORK_TYPE_ICON[item.workType]
    case 'file': return 'doc'
    case 'image': return 'photo'
    case 'automation': return 'clock'
  }
}
