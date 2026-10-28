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
  /** The number of artifacts this session, or a session below it in its delegation tree, made or worked on. */
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

/**
 * Every session below this one in its delegation tree: the sessions it
 * started, the ones they started, and so on. A chain of delegations belongs to
 * its top session, as the sidebar nests it (`nestedRowParents`). Each level is
 * read with `childrenOf` (the host's `sessionRecordList({ parentSessionId })`),
 * so the host decides what the reader may list. A failed read rejects.
 */
export async function delegatedSessionIds(
  sessionId: string,
  childrenOf: (parentSessionId: string) => Promise<readonly string[]>,
): Promise<Set<string>> {
  const found = new Set<string>()
  let level = [sessionId]
  while (level.length > 0) {
    const children = (await Promise.all(level.map(childrenOf))).flat()
    // A cycle, or the session itself, is never read twice.
    level = children.filter((id) => id !== sessionId && !found.has(id))
    for (const id of level) found.add(id)
  }
  return found
}

/**
 * The artifact works of a session, the last changed first: the ones linked to
 * the session, and the ones linked to a session below it in its delegation
 * tree (`delegatedSessionIds`). A worker's
 * artifact belongs to the worker, but its report shows it in the sender's
 * conversation, so the sender's view counts it too. Only works the reader can
 * list count: `works` is the reader's own list.
 */
export function sessionArtifacts<T extends WorkMeta & { id: string }>(
  works: Iterable<T>,
  sessionId: string | undefined,
  delegatedSessionIds: ReadonlySet<string> = new Set(),
): T[] {
  if (!sessionId) return []
  const linked = (id: string | undefined) => id === sessionId || (id !== undefined && delegatedSessionIds.has(id))
  const artifacts: T[] = []
  for (const work of works) {
    if (work.type !== 'artifact') continue
    if (linked(work.sessionId) || work.sessionIds?.some(linked)) artifacts.push(work)
  }
  return artifacts.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
}
