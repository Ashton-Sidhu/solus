import {
  ENVIRONMENT_VIEWS,
  ENVIRONMENT_VIEW_LABELS,
  delegatedSessionIds,
  environmentViewFor,
  sessionArtifacts,
  type EnvironmentView,
  type EnvironmentViewFacts,
} from '@solus/client-core/environment-view'
import type { HostApi } from '@solus/client-core/host-api'
import type { WorkListingMeta } from '@solus/contracts/types'
import type { ScreenHeaderMenu } from '../../components/ScreenHeader.types'
import type { TranscriptItem } from '../conversation/lib/transcript-model'

/**
 * The thread header's environment menu: the phone's form of the desktop
 * Environment card's view row. It names the session's view by the shared rule
 * and offers Browser, Builds, and Artifacts.
 */

const VIEW_ICON = { browser: 'globe', builds: 'hammer', artifacts: 'sparkles' } as const satisfies { readonly [view in EnvironmentView]: string }

/** The session's artifacts as the loaded transcript shows them. */
export interface TranscriptArtifacts {
  /** The newest artifact row, which the menu opens. */
  latestId: string | null
  /** One per work: revisions of a work count once. */
  count: number
}

export function transcriptArtifacts(order: readonly string[], item: (id: string) => TranscriptItem | undefined): TranscriptArtifacts {
  const works = new Set<string>()
  let count = 0
  let latestId: string | null = null
  for (const id of order) {
    const row = item(id)
    if (row?.kind !== 'artifact') continue
    latestId = id
    // Revisions of one work are one artifact; a render without a work is its own.
    if (!row.workId) count += 1
    else if (!works.has(row.workId)) {
      works.add(row.workId)
      count += 1
    }
  }
  return { latestId, count }
}

/**
 * The artifact works of the sessions below this one in its delegation tree,
 * the last changed first. Their reports show them in this conversation (or in
 * a delegate's), but this transcript has no artifact row for them. The host
 * lists only what the reader may see.
 */
export async function delegatedArtifacts(api: Pick<HostApi, 'sessionRecordList' | 'listWorks'>, sessionId: string): Promise<WorkListingMeta[]> {
  const delegated = await delegatedSessionIds(sessionId, (parentSessionId) =>
    api.sessionRecordList({ parentSessionId }).then((answer) => answer.records.map((record) => record.sessionId)))
  if (delegated.size === 0) return []
  // The session's own artifacts come from its transcript.
  const linkedHere = (work: WorkListingMeta) => work.sessionId === sessionId || !!work.sessionIds?.includes(sessionId)
  return sessionArtifacts(await api.listWorks(), sessionId, delegated).filter((work) => !linkedHere(work))
}

/** Window-only choices, keyed by host and session, as on desktop. */
const choices = new Map<string, EnvironmentView>()

export function chosenEnvironmentView(hostId: string, sessionId: string): EnvironmentView | undefined {
  return choices.get(`${hostId}\u0000${sessionId}`)
}

export function chooseEnvironmentView(hostId: string, sessionId: string, view: EnvironmentView): void {
  choices.set(`${hostId}\u0000${sessionId}`, view)
}

export function phoneEnvironmentFacts(input: { chosen?: EnvironmentView; artifactCount: number; artifactsKnown: boolean }): EnvironmentViewFacts {
  // The phone reads no device previews, so only a choice makes Builds the view here.
  return { ...input, sessionShowsDevice: false }
}

export function environmentViewMenu(facts: EnvironmentViewFacts, onChoose: (view: EnvironmentView) => void): ScreenHeaderMenu {
  const view = environmentViewFor(facts)
  return {
    title: 'Environment',
    icon: VIEW_ICON[view ?? 'browser'],
    status: view ? ENVIRONMENT_VIEW_LABELS[view] : 'Checking session…',
    items: ENVIRONMENT_VIEWS.map((option) => ({
      id: option,
      title: ENVIRONMENT_VIEW_LABELS[option],
      icon: VIEW_ICON[option],
      selected: option === view,
      onPress: () => onChoose(option),
    })),
  }
}
