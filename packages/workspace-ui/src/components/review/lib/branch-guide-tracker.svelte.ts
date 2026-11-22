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
 * One probe per branch guide, owned here rather than by each mounted Git
 * section. A guide is probed once per host, repository, and branch, when a
 * source first shows it; the answer renders from the store from then on, and
 * the store reads its tracked guides again after a reconnect. A section that
 * mounts again, or another tab on the same branch, sends no probe. Whether that guide is still
 * current is checked only when it is opened (the review surface asks on
 * mount), never on every working-tree move. Host bindings and the checkout
 * HEAD are read untracked, so nothing else re-probes.
 */
export function trackBranchReviewGuides(
  workspace: Pick<WorkspaceContext, 'runFor' | 'apiFor' | 'serverIdFor' | 'ctxForEnvironment'>,
  environmentStore: Pick<SessionEnvironmentStore, 'environmentFor'>,
): void {
  const probedGuides = new Set<string>()
  $effect(() => {
    for (const sourceId of shownSources.keys()) {
      const environment = environmentStore.environmentFor(workspace.runFor(sourceId))
      if (!environment.repoRoot || !environment.branch) continue
      const probeKey = `${untrack(() => workspace.serverIdFor(sourceId))}::${environment.repoRoot}::${environment.branch}`
      if (probedGuides.has(probeKey)) continue
      probedGuides.add(probeKey)
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
  })
}
