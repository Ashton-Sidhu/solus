import { hostPathBaseName } from '@solus/contracts/host-path'
import type { SessionArtifact, SessionArtifactKind, SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'

/**
 * The chips a session card shows for what the session linked
 * (docs/plans/session-artifacts.md): one chip per item on the card, and one
 * total per kind on a folded group. Desktop, web, and the phone draw the same
 * chips from this model.
 *
 * The tone is the type, except for a pull request: its chip is plain, and its
 * icon takes the colour of its state.
 */
export type ArtifactChipTone = 'pull-request' | 'written' | 'drawn' | 'file' | 'image' | 'automation'

/** What PR sync last saw; null until it first answers. */
export type PullRequestChipState = 'open' | 'draft' | 'merged' | 'closed' | 'missing'

export interface ArtifactChip {
  tone: ArtifactChipTone
  label: string
  /** Muted text after the label: a pull request's state. */
  note: string | null
  /** A pull request's state, for its icon. */
  pullRequestState: PullRequestChipState | null
  artifact: SessionArtifact
}

export interface ArtifactChipTotal {
  kind: SessionArtifactKind
  tone: ArtifactChipTone
  count: number
  label: string
  pullRequestState: PullRequestChipState | null
}

/** The chips a card shows, and how many it leaves to `+N`. */
export interface CardChips {
  shown: ArtifactChip[]
  hiddenCount: number
}

/** Chips a card shows before it counts the rest as `+N`. */
export const MAX_CARD_CHIPS = 4

const KIND_ORDER: readonly SessionArtifactKind[] = ['pull-request', 'work', 'file', 'image', 'automation']

const KIND_NOUN = {
  'pull-request': ['PR', 'PRs'],
  work: ['work', 'works'],
  file: ['file', 'files'],
  image: ['image', 'images'],
  automation: ['automation', 'automations'],
} as const satisfies { [Kind in SessionArtifactKind]: readonly [string, string] }

const STATE_NOTE = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
  missing: 'Missing',
} as const satisfies { [State in PullRequestChipState]: string }

/** A folded group's PR total shows the state that most needs the reader. */
const STATE_RANK: readonly PullRequestChipState[] = ['open', 'draft', 'merged', 'closed', 'missing']

export function pullRequestChipState(link: SessionPullRequestLink): PullRequestChipState | null {
  if (link.missing) return 'missing'
  const snapshot = link.snapshot
  if (!snapshot) return null
  if (snapshot.state === 'open' && snapshot.draft) return 'draft'
  return snapshot.state
}

function toneOf(artifact: SessionArtifact): ArtifactChipTone {
  switch (artifact.kind) {
    case 'work':
      return artifact.workType === 'doc' || artifact.workType === 'slides' ? 'written' : 'drawn'
    case 'pull-request':
    case 'file':
    case 'image':
    case 'automation':
      return artifact.kind
  }
}

export function artifactChip(artifact: SessionArtifact): ArtifactChip {
  switch (artifact.kind) {
    case 'pull-request': {
      const state = pullRequestChipState(artifact.link)
      return {
        tone: 'pull-request',
        label: `#${artifact.link.number}`,
        note: state ? STATE_NOTE[state] : null,
        pullRequestState: state,
        artifact,
      }
    }
    case 'file':
    case 'image':
      return { tone: artifact.kind, label: hostPathBaseName(artifact.path) || artifact.title, note: null, pullRequestState: null, artifact }
    case 'work':
    case 'automation':
      return { tone: toneOf(artifact), label: artifact.title || 'Untitled', note: null, pullRequestState: null, artifact }
  }
}

/**
 * One session's items in a list read for `ownerSessionId`: the list's own
 * items when it is that session's list, otherwise the group of the session it
 * started. Null when the list does not name the session.
 */
export function sessionArtifactItems(
  artifacts: SessionArtifacts | null,
  ownerSessionId: string,
  sessionId: string,
): readonly SessionArtifact[] | null {
  if (!artifacts) return null
  if (ownerSessionId === sessionId) return artifacts.own
  return artifacts.children.find((group) => group.sessionId === sessionId)?.items ?? null
}

/** The chips a card shows, newest link first, and how many it leaves to `+N`. */
export function cardChips(items: readonly SessionArtifact[], max = MAX_CARD_CHIPS): CardChips {
  // `+N` takes a chip's place, so a list one over the limit shows every chip.
  const fits = items.length <= max + 1
  return {
    shown: (fits ? items : items.slice(0, max)).map(artifactChip),
    hiddenCount: fits ? 0 : items.length - max,
  }
}

/** One total per kind across the sessions of a folded group, in a fixed order. */
export function chipTotals(itemLists: readonly (readonly SessionArtifact[])[]): ArtifactChipTotal[] {
  const items = itemLists.flat()
  const totals: ArtifactChipTotal[] = []
  for (const kind of KIND_ORDER) {
    const ofKind = items.filter((item) => item.kind === kind)
    if (ofKind.length === 0) continue
    const [singular, plural] = KIND_NOUN[kind]
    const states = ofKind.flatMap((item) => (item.kind === 'pull-request' ? [pullRequestChipState(item.link)] : []))
    totals.push({
      kind,
      // Lists come newest first: mixed works take the newest one's tone.
      tone: toneOf(ofKind[0]),
      count: ofKind.length,
      label: `${ofKind.length} ${ofKind.length === 1 ? singular : plural}`,
      pullRequestState: STATE_RANK.find((state) => states.includes(state)) ?? null,
    })
  }
  return totals
}
