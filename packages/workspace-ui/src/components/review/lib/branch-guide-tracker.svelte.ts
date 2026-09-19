import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { WorkspaceContext } from '../../../contexts'
import type { SessionEnvironmentStore } from '../../../contexts/git/session-environment.store.svelte'
import { branchGuideIdentity, reviewGuideStore } from '../review-guide.store.svelte'

/** Sources whose branch guide is on screen, counted per mounted Git section. */
const shownSources = new SvelteMap<string, number>()

/** A Git section declares the source it describes; the tracker below owns the
 * host probe. Returns the release for unmount. */
export function showBranchReviewGuide(sourceId: string): () => void {
  // Registration must not make the caller's effect depend on the count it
  // changes, or cleanup and registration will keep triggering each other.
  untrack(() => shownSources.set(sourceId, (shownSources.get(sourceId) ?? 0) + 1))
  return () => untrack(() => {
    const remaining = (shownSources.get(sourceId) ?? 1) - 1
    if (remaining > 0) shownSources.set(sourceId, remaining)
    else shownSources.delete(sourceId)
  })
}

/**
 * One probe per shown branch guide, owned here rather than by each mounted Git
 * section. A guide is probed once, when its source first shows a branch; the
 * answer renders from the store from then on. Whether that guide is still
 * current is checked only when it is opened (the review surface asks on
 * mount), never on every working-tree move. Host bindings and the checkout
 * HEAD are read untracked, so nothing else re-probes.
 */
export function trackBranchReviewGuides(
  workspace: Pick<WorkspaceContext, 'runFor' | 'apiFor' | 'serverIdFor' | 'ctxForEnvironment'>,
  environmentStore: Pick<SessionEnvironmentStore, 'environmentFor'>,
): void {
  const probedGuides = new Map<string, string>()
  $effect(() => {
    for (const sourceId of shownSources.keys()) {
      const environment = environmentStore.environmentFor(workspace.runFor(sourceId))
      const probeKey = environment.repoRoot && environment.branch
        ? `${environment.repoRoot}::${environment.branch}`
        : null
      if (!probeKey || probedGuides.get(sourceId) === probeKey) continue
      probedGuides.set(sourceId, probeKey)
      untrack(() => {
        const identity = branchGuideIdentity(environment)
        if (!identity) return
        void reviewGuideStore.load(
          workspace.apiFor(sourceId),
          workspace.serverIdFor(sourceId),
          workspace.ctxForEnvironment(environment.cwd, environment.checkout, sourceId),
          identity,
          'branch',
        )
      })
    }
    for (const sourceId of probedGuides.keys()) {
      if (!shownSources.has(sourceId)) probedGuides.delete(sourceId)
    }
  })
}
