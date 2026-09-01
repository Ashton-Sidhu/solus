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

export function showsPrPageSkeleton(phase: ScopeSwitchPhase, loading: boolean, rowCount: number): boolean {
  if (phase !== 'idle') return true
  return loading && rowCount === 0
}
