import type { PrReviewTarget, PullRequest } from "@solus/contracts/providers";
import type { IpcContext } from "@solus/contracts/types";
import type { HostApi } from "@solus/client-core/host-api";
import type { LensPullRequestAdapter } from "../../review/lib/lens-surface";
import type { LensSubject } from "../../review/review-lens.store.svelte";
import { prGuideTarget } from "../../review/review-guide.store.svelte";
import type { PrReviewState } from "./pr-review.store.svelte";

/** A pull request's lens is keyed by the pull request and the revision it
 *  reads; the key string keeps a new ctx object from reading it again. */
export function prLensSubjectKey(serverId: string, pr: PrReviewTarget | null): string | null {
  return pr ? JSON.stringify([serverId, pr.host, pr.owner, pr.repo, pr.number, pr.headSha, pr.baseSha]) : null;
}

export function prLensSubject(api: HostApi, serverId: string, ctx: IpcContext, pr: PrReviewTarget): LensSubject {
  // The target identity is enough: a PR lens is stored per remote repository.
  return { api, serverId, ctx, target: prGuideTarget(pr), scopeKey: "pr" };
}

/** How a lens comment reaches this pull request: the review draft it adds line
 *  comments to (sent with Submit review), and the patch the lines must be in. */
export function prLensAdapter(review: PrReviewState, detail: PullRequest | null): LensPullRequestAdapter {
  return {
    canComment: !!detail?.viewerPermissions.comment,
    commentReason: detail
      ? "You do not have permission to comment on this pull request."
      : "Loading the pull request…",
    patch: review.diffPatch,
    drafts: review.drafts.drafts,
    addDraft: (anchor, body) =>
      review.drafts.save({
        filePath: anchor.path,
        startLine: anchor.line,
        endLine: anchor.line,
        side: "new",
        selectedCode: "",
        comment: body,
      }),
    removeDraft: (draftId) => review.drafts.remove(draftId),
  };
}
