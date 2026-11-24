import { patchPullRequestListEntries, pullRequestPendingEditsAtom } from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentId, PullRequestListInput, PullRequestRef, PullRequestSummary } from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { shownPullRequestListPages, type PullRequestListPages } from "../features/pull-requests/pullRequestList";
import { hostQueryScope } from "../state/host-query-scope";
import { solusPrList } from "./source-control";

export const pullRequestListPagesKey = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestListInput;
  readonly scope?: string;
}) =>
  JSON.stringify([
    target.environmentId,
    target.input,
    target.scope ?? hostQueryScope(target.environmentId),
  ]);

// Which listing each pages atom holds, so an action's reply can reach the pages past its head.
export const pullRequestListPagesTargets = new WeakMap<
  object,
  readonly [EnvironmentId, PullRequestListInput, string]
>();
/** The pages loaded past each listing's head, keyed by {@link pullRequestListPagesKey}. */
export const pullRequestListPagesFamily = Atom.family((key: string) => {
  const atom = Atom.make<PullRequestListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000));
  pullRequestListPagesTargets.set(atom, JSON.parse(key));
  return atom;
});

/** Apply the canonical host reply to the first page and any loaded continuations. */
export function applyPrListReply(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  reply?: PullRequestSummary,
) {
  const scope = hostQueryScope(environmentId);
  for (const atom of registry.getNodes().keys()) {
    const listing = typeof atom === "string" ? undefined : pullRequestListPagesTargets.get(atom);
    if (!listing || listing[0] !== environmentId || listing[2] !== scope) continue;
    const input = listing[1];
    if ((input.projectId && input.projectId !== reference.projectId) ||
      (input.projectIds && !input.projectIds.includes(reference.projectId)) ||
      (input.host && reference.host && input.host !== reference.host)) continue;
    const source = solusPrList({ environmentId, input, scope });
    if (!reply) {
      registry.refresh(source);
      continue;
    }
    const head = AsyncResult.getOrElse(registry.get(source), () => null);
    registry.update(atom as Atom.Writable<PullRequestListPages | null>, (held) => {
      const pages = shownPullRequestListPages(held, head);
      if (!pages) return held;
      const entries = patchPullRequestListEntries(input, pages.entries, reference, reply,
        registry.get(pullRequestPendingEditsAtom(environmentId)));
      if (entries === "refresh") {
        registry.refresh(source);
        return held;
      }
      return entries === pages.entries ? held : { ...pages, entries };
    });
  }
}
