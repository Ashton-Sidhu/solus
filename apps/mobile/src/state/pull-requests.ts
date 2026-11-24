import { prGuide, generatePrGuide } from "../solus/pr-guide";
import {
  editPr,
  runPrAction,
  labelPr,
  commentPr,
  reviewPr,
  requestPrReviewers,
  prLabelChoices,
  prReviewerChoices,
  prFilesViewed,
  setPrFilesViewed,
} from "../solus/source-control-actions";
import { applyPrListReply, pullRequestListPagesFamily, pullRequestListPagesKey, pullRequestListPagesTargets } from "../solus/pr-list-cache";
import { hostQueryScope } from "./host-query-scope";
import {
  solusPrList,
  solusPrDetail,
  solusPrActivity,
  solusPrDiff,
  solusPrBreakdown,
  solusPrStack,
  solusPrFilterOptions,
} from "../solus/source-control";
import {
  createPullRequestEnvironmentAtoms,
  editHeldPullRequestListEntries,
  pullRequestPendingEditsAtom,
} from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  EMPTY_PULL_REQUEST_STATS_CACHE,
  pullRequestListHead,
  withAnsweredPullRequestStats,
  withListedPullRequests,
  type PullRequestListPages,
  type PullRequestStatsCache,
} from "../features/pull-requests/pullRequestList";

export { pullRequestListPagesKey, pullRequestListPagesFamily } from "../solus/pr-list-cache";

/** Diff stats each environment has answered so far, so rows keep them when they scroll away. */
export const pullRequestListStatsFamily = Atom.family((_environmentId: string) =>
  Atom.make<PullRequestStatsCache>(EMPTY_PULL_REQUEST_STATS_CACHE).pipe(
    Atom.setIdleTTL(5 * 60_000),
  ),
);

/** Completed server reads of each viewed-files query; unchanged answers are structurally shared. */
export const filesViewedReadsFamily = Atom.family((source: ReturnType<typeof prFilesViewed>) =>
  Atom.map(
    Atom.make((get) => {
      const result = get(source);
      const previous = Option.getOrElse(get.self<{
        readonly answer: typeof result | null;
        readonly count: number;
      }>(), () => ({ answer: null, count: 0 }));
      return result._tag === "Success" && !result.waiting && result !== previous.answer
        ? { answer: result, count: previous.count + 1 }
        : previous;
    }),
    ({ count }) => count,
  ),
);

const upstreamPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  // Rows on pages past each listing's head; the head itself is patched where it is cached.
  actionReply: (target, reply, registry) =>
    Effect.sync(() => applyPrListReply(registry, target.environmentId, target.input, reply)),
  acceptedEdit: (target, edit, registry) =>
    Effect.sync(() => {
      for (const atom of registry.getNodes().keys()) {
        const listing =
          typeof atom === "string" ? undefined : pullRequestListPagesTargets.get(atom);
        if (listing === undefined || listing[0] !== target.environmentId ||
          listing[2] !== hostQueryScope(target.environmentId)) continue;
        registry.update(atom as Atom.Writable<PullRequestListPages | null>, (pages) => {
          if (pages === null) return pages;
          const entries = editHeldPullRequestListEntries(
            listing[1],
            pages.entries,
            () => [edit],
            registry.get(pullRequestPendingEditsAtom(target.environmentId)),
          );
          return entries === pages.entries ? pages : { ...pages, entries };
        });
      }
    }),
  list: (target, value, registry) =>
    Effect.sync(() => {
      const statsAtom = pullRequestListStatsFamily(target.environmentId);
      const { cache, refresh } = withListedPullRequests(registry.get(statsAtom), value.entries);
      registry.set(statsAtom, cache);
      for (const input of refresh)
        registry.refresh(
          upstreamPullRequests.listStats({ environmentId: target.environmentId, input }),
        );
      if (target.input.cursors === undefined)
        registry.update(pullRequestListPagesFamily(pullRequestListPagesKey(target)), (previous) =>
          pullRequestListHead(previous, value),
        );
    }),
  listStats: (target, value, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestListStatsFamily(target.environmentId), (previous) =>
        withAnsweredPullRequestStats(previous, target.input, value.stats),
      ),
    ),
});
const detailReadVersion = Atom.family((source: ReturnType<typeof solusPrDetail>) =>
  Atom.make((get) => {
    const result = get(source);
    return result._tag === "Success" && !result.waiting
      ? result.timestamp
      : Option.getOrElse(get.self<number>(), () => 0);
  }),
);

export const composerPullRequests = {
  ...upstreamPullRequests,
  reviewGuide: prGuide,
  generateReviewGuide: generatePrGuide,
  list: solusPrList,
  update: editPr,
  runAction: runPrAction,
  setLabels: labelPr,
  filesViewed: prFilesViewed,
  setFilesViewed: setPrFilesViewed,
  comment: commentPr,
  submitReview: reviewPr,
  requestReviewers: requestPrReviewers,
  labelCandidates: prLabelChoices,
  reviewerCandidates: prReviewerChoices,
  detail: solusPrDetail,
  detailReadVersion: (target: Parameters<typeof solusPrDetail>[0]) =>
    detailReadVersion(solusPrDetail(target)),
  activity: solusPrActivity,
  diff: solusPrDiff,
  changeBreakdown: solusPrBreakdown,
  filterOptions: solusPrFilterOptions,
};
export const pullRequestStackAtom = solusPrStack;
