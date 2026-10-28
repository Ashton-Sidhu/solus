import type { WorkMeta } from '@solus/contracts/types'

/**
 * What a session's environment shows: the browser, the app builds, or the
 * session's artifacts. Desktop and web show it as the Environment card's split
 * row; the phone shows it as a menu in the thread header. One rule decides the
 * view for every client.
 */
export type EnvironmentView = 'browser' | 'builds' | 'artifacts'

export const ENVIRONMENT_VIEWS: readonly EnvironmentView[] = ['browser', 'builds', 'artifacts']

export const ENVIRONMENT_VIEW_LABELS = { browser: 'Browser', builds: 'Builds', artifacts: 'Artifacts' } as const satisfies { readonly [view in EnvironmentView]: string }

export interface EnvironmentViewFacts {
  /** The user's choice for this session, when they made one. */
  chosen?: EnvironmentView
  /** The session shows a simulator or phone now. */
  sessionShowsDevice: boolean
  /** The number of artifacts this session made or worked on. */
  artifactCount: number
  /** False until the client has read the session's artifacts once. */
  artifactsKnown: boolean
}

/**
 * The view the session opens, or null while it cannot be known yet. The
 * user's choice wins. Without one, a session that shows a device opens its
 * builds, a session with an artifact opens the artifact, and every other
 * session opens the browser. Until the artifacts have answered, a session
 * that may still have one waits, so the label never changes from Browser to
 * Artifacts under the user.
 */
export function environmentViewFor(facts: EnvironmentViewFacts): EnvironmentView | null {
  if (facts.chosen) return facts.chosen
  if (facts.sessionShowsDevice) return 'builds'
  if (facts.artifactCount > 0) return 'artifacts'
  if (!facts.artifactsKnown) return null
  return 'browser'
}

/** The artifact works linked to a session, the last changed first. */
export function sessionArtifacts<T extends WorkMeta & { id: string }>(works: Iterable<T>, sessionId: string | undefined): T[] {
  if (!sessionId) return []
  const artifacts: T[] = []
  for (const work of works) {
    if (work.type !== 'artifact') continue
    if (work.sessionId === sessionId || work.sessionIds?.includes(sessionId)) artifacts.push(work)
  }
  return artifacts.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
}
