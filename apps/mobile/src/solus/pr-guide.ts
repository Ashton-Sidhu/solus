import {
  reviewGuideKeyForTarget,
  type ReviewGuide,
  type ReviewGuideStatusEvent,
} from "@solus/contracts/review";
import { persistQuery } from "@t3tools/client-runtime/state/query-persistence";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  PullRequestReviewGuide,
  type PullRequestRef,
  PullRequestReviewGuideResult,
  type PullRequestReviewGuideExcerpt,
} from "@t3tools/contracts";
import { hostQuery } from "./host-query";
import { hostCommand } from "./host-command";
import { prDiffSource } from "./source-control";

const MobileGuideResult = Schema.Struct({
  ...PullRequestReviewGuideResult.fields,
  guide: Schema.NullOr(PullRequestReviewGuide.mapFields(Struct.omit(["modelSelection"]))),
});
export type MobileGuideResult = typeof MobileGuideResult.Type;

export function projectPrGuide(
  head: string,
  saved: ReviewGuide | null,
  status: ReviewGuideStatusEvent | null,
): MobileGuideResult {
  const timestamp = status ? new Date(status.updatedAt).toISOString() : null;
  const generatedAt = saved?.generatedAt ?? status?.generatedAt;
  return {
    currentHeadSha: head,
    run:
      status && timestamp && (status.status === "queued" || status.status === "generating")
        ? { _tag: "Running", headSha: status.headSha, startedAt: timestamp }
        : status && timestamp && status.status === "failed"
          ? {
              _tag: "Failed",
              headSha: status.headSha,
              failedAt: timestamp,
              detail: status.error || "Could not generate the guide.",
            }
          : null,
    guide:
      saved && generatedAt
        ? {
            headSha: saved.headSha,
            generatedAt,
            stops: [...saved.sections]
              .sort((a, b) => a.order - b.order)
              .map((section) => ({
                title: section.title,
                summary: section.explanation,
                attention: section.attention ?? null,
                files: section.files.map(({ path }) => ({ path })),
                notes: [],
                questions: [],
                excerpts: section.files.flatMap(({ path, hunks }) => {
                  const ranges: PullRequestReviewGuideExcerpt[] = [];
                  for (const hunk of hunks?.matchAll(
                    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm,
                  ) ?? []) {
                    const removed = Number(hunk[4] ?? 1) === 0;
                    const start = Number(hunk[removed ? 1 : 3]);
                    const count = Number(hunk[removed ? 2 : 4] ?? 1);
                    if (start > 0 && count > 0)
                      ranges.push({
                        path,
                        side: removed ? "old" : "new",
                        start,
                        end: start + count - 1,
                        caption: "",
                      });
                  }
                  return ranges;
                }),
              })),
          }
        : null,
  };
}

export const prGuide = hostQuery(
  async (id, input: PullRequestRef) => {
    const { api, ctx, target: pr } = await prDiffSource(id, input);
    const target = { kind: "pr" as const, ...pr };
    const [status, guide] = await Promise.all([
      api.reviewGuideStatus(ctx, { target }),
      api.readGuide(ctx, reviewGuideKeyForTarget(target, ""), target),
    ]);
    return projectPrGuide(pr.headSha, guide, status);
  },
  {
    label: "environment-data:pull-requests:review-guide",
    persistence: persistQuery(MobileGuideResult),
    staleTimeMs: 60_000,
  },
);

export const generatePrGuide = hostCommand(
  "pullRequests.generateReviewGuide",
  "host.use",
  async (id, input: PullRequestRef, registry, check) => {
    const { api, ctx, target } = await prDiffSource(id, input);
    check();
    const started = await api.requestReviewGuide(ctx, { target: { kind: "pr", ...target } });
    if (!started) throw new Error("The host could not start the review guide.");
    registry.refresh(prGuide({ environmentId: id, input }));
  },
);
