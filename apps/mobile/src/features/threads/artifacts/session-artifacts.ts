import type { WorkType } from '@solus/contracts/types'
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

/** The sections for one filter. A section with nothing to show is left out. */
export function artifactSections(artifacts: SessionArtifacts, filter: ArtifactFilter): ArtifactSection[] {
  const shown = (items: readonly SessionArtifact[]) => filter === 'all' ? items : items.filter((item) => item.kind === filter)
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

/** A row's title and the line under it. */
export interface ArtifactRowText {
  readonly title: string
  readonly detail: string
}

export function artifactRowText(item: SessionArtifact): ArtifactRowText {
  switch (item.kind) {
    case 'pull-request': return { title: item.link.title || `#${item.link.number}`, detail: `${item.link.repository} #${item.link.number}` }
    case 'work': return { title: item.title, detail: WORK_TYPE_LABEL[item.workType] }
    case 'file':
    case 'image': return { title: item.title, detail: item.path }
    case 'automation': return { title: item.title, detail: 'Automation' }
  }
}
