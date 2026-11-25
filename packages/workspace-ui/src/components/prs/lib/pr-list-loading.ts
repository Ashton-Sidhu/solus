/**
 * Whether the pull request page owes the reader its loading skeleton.
 *
 * A refresh and a scope switch look identical to the stores — both raise
 * `loading` — but they are not the same to the reader. A refresh restates the
 * list already on screen, so blanking it would be a step backwards: the rows
 * stay and the head band carries the refresh. A switch replaces the list, and
 * every row on screen belongs to the scope the reader just left, so keeping
 * them shows one project's pull requests under another project's title until
 * the new read lands. The skeleton is what stands there in between.
 */

/** How far a switch started from the project picker has got.
 *
 * `starting` is the flush that dispatches the new scope's reads — they have
 * not raised their own loading flags yet, so nothing else can be asked.
 * `reading` is the wait for those reads to settle. */
export type ScopeSwitchPhase = 'idle' | 'starting' | 'reading'

/** `loadedRows` counts the rows the scope holds before the page's filters.
 *  A read for a search or a filter never takes the page: the skeleton
 *  replaces the toolbar too, which unmounts the search field and the Filters
 *  menu while the reader uses them. The list area shows its own row skeleton
 *  for that read. */
export function showsPrPageSkeleton(
  phase: ScopeSwitchPhase,
  loading: boolean,
  loadedRows: number,
  searching: boolean,
): boolean {
  if (phase !== 'idle') return true
  return loading && loadedRows === 0 && !searching
}

/** What the page knows of one project's read. */
export interface PrScopeRead {
  loading: boolean
  error: { kind: string } | null
  filter: { query?: string }
}

/**
 * Has every project in view answered the search and the filters now set?
 * Until it has, the rows on screen are the answer to the previous question,
 * so an empty list says it is loading, not that nothing matches. A project
 * the host has said has no pull requests is never asked again, so it is not
 * waited for.
 */
export function prHostAnswered(scopes: readonly PrScopeRead[], hostQuery: string): boolean {
  return scopes.every(
    (scope) => scope.error?.kind === 'unavailable' || (!scope.loading && (scope.filter.query ?? '') === hostQuery),
  )
}

/**
 * The list only gives width to the detail panel when that panel can render.
 * A remembered key can outlive the row after a refresh or filter change; that
 * stale key must not leave a narrow list beside an empty surface.
 */
export function showsPrDetailPanel(
  hasPullRequest: boolean,
  hasTarget: boolean,
): boolean {
  return hasPullRequest && hasTarget
}
