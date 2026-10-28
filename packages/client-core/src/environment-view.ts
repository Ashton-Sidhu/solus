/**
 * What a session's environment shows: the browser, the app builds, or the
 * session's Artifacts surface. Desktop and web show it as the Environment
 * card's split row; the phone shows it as a menu in the thread header. One
 * rule decides the view for every client.
 */
export type EnvironmentView = 'browser' | 'builds' | 'artifacts'

export const ENVIRONMENT_VIEWS: readonly EnvironmentView[] = ['browser', 'builds', 'artifacts']

export const ENVIRONMENT_VIEW_LABELS = { browser: 'Browser', builds: 'Builds', artifacts: 'Artifacts' } as const satisfies { readonly [view in EnvironmentView]: string }

export interface EnvironmentViewFacts {
  /** The user's choice for this session, when they made one. */
  chosen?: EnvironmentView
  /** The session shows a simulator or phone now. */
  sessionShowsDevice: boolean
  /** The number of artifacts the session's Artifacts surface lists: its own and those of its delegation tree. */
  artifactCount: number
  /** False until the client has read the session's artifacts once. */
  artifactsKnown: boolean
}

/**
 * The view the session opens, or null while it cannot be known yet. The
 * user's choice wins. Without one, a session that shows a device opens its
 * builds, a session with an artifact opens its Artifacts surface, and every other
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
