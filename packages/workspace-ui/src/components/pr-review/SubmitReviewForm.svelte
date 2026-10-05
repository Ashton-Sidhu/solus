<script lang="ts">
  import ReviewComposer from "../ui/review-composer/ReviewComposer.svelte";
  import type { PrReviewTarget, PrReviewVerdict } from "@solus/contracts/providers";
  import type { DraftReview, DraftReviewComment } from "@solus/contracts/providers";
  import type { ReviewDraftComment } from "@solus/contracts/review";
  import { toasts } from "../../lib/toasts";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { Button } from "../ui/button";
  import type { PrFixFeedback } from "./lib/pr-input-drafts";

  // The review popover body (decision #14): write a summary, pick a verdict,
  // glance at the queued line comments, and fire one prSubmitReview anchored
  // to the PR head SHA. It hangs from the Review button rather than covering
  // the diff, so the change stays readable while the summary is written.
  // Event + body are bindable so the host owns them — dismissing never
  // destroys a typed summary; it's there again on reopen.
  let {
    pr,
    drafts,
    event = $bindable("COMMENT"),
    body = $bindable(""),
    onClose,
    onSubmitted,
    submitReview,
    onDraftFixes,
    supportedVerdicts,
    allowedVerdicts,
  }: {
    pr: PrReviewTarget;
    drafts: ReviewDraftComment[];
    event?: DraftReview["event"];
    body?: string;
    onClose: () => void;
    onSubmitted: () => void;
    /** Submits the draft against the PR's own project. Injected so the form
     *  composes a review without owning where one is posted. */
    submitReview: (review: DraftReview) => Promise<void>;
    onDraftFixes?: (feedback: PrFixFeedback) => void | Promise<void>;
    /** Verdicts the host offers on this pull request; shown even when the
     *  viewer may not use them, so a missing Approve is explained, not hidden. */
    supportedVerdicts: PrReviewVerdict[];
    /** Verdicts this viewer may submit (e.g. an author may only comment). */
    allowedVerdicts: PrReviewVerdict[];
  } = $props();

  // The shared composer gives each verdict its color and icon.
  const EVENTS: {
    id: DraftReview["event"];
    label: string;
  }[] = [
    { id: "COMMENT", label: "Comment" },
    { id: "APPROVE", label: "Approve" },
    { id: "REQUEST_CHANGES", label: "Request changes" },
  ];
  const eventVerdict = (reviewEvent: DraftReview["event"]): PrReviewVerdict =>
    reviewEvent === "APPROVE"
      ? "approve"
      : reviewEvent === "REQUEST_CHANGES"
        ? "request-changes"
        : "comment";
  const shownEvents = $derived(
    EVENTS.filter((reviewEvent) => supportedVerdicts.includes(eventVerdict(reviewEvent.id))),
  );
  const availableEvents = $derived(
    shownEvents.filter((reviewEvent) => allowedVerdicts.includes(eventVerdict(reviewEvent.id))),
  );
  const choices = $derived(shownEvents.map((reviewEvent) => ({
    value: reviewEvent.id,
    label: reviewEvent.label,
    kind: eventVerdict(reviewEvent.id),
    disabled: !allowedVerdicts.includes(eventVerdict(reviewEvent.id)),
    disabledReason: !allowedVerdicts.includes(eventVerdict(reviewEvent.id))
      ? `Authors can't ${reviewEvent.label.toLowerCase()} on their own pull request` : undefined,
  })));
  let submitting = $state(false);

  $effect(() => {
    if (!availableEvents.some((reviewEvent) => reviewEvent.id === event)) {
      event = availableEvents[0]?.id ?? "COMMENT";
    }
  });

  async function submit(draftFixes = false) {
    submitting = true;
    const feedback = {
      body: body.trim(),
      comments: drafts.map((draft) => ({ ...draft })),
    };
    const comments: DraftReviewComment[] = drafts.map((d) => {
      const comment: DraftReviewComment = {
        path: d.path,
        line: d.line,
        side: d.side === "old" ? "LEFT" : "RIGHT",
        body: d.body,
      };
      if (d.startLine !== undefined) comment.startLine = d.startLine;
      return comment;
    });
    const review: DraftReview = { body: body.trim(), event, commitId: pr.headSha, baseSha: pr.baseSha, comments };
    try {
      await submitReview(review);
      body = "";
      onSubmitted();
      onClose();
      toasts.success("Review submitted");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toasts.error("Submit failed", { description: message });
      return;
    } finally {
      submitting = false;
    }
    if (draftFixes) {
      try {
        await onDraftFixes?.(feedback);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toasts.error("Review submitted, but the fix draft couldn't be prepared", {
          description: message,
        });
      }
    }
  }

  // GitHub rejects a COMMENT or REQUEST_CHANGES review that carries neither a
  // summary body nor any inline comments with a bare 422 "Unprocessable Entity".
  // Only APPROVE may be empty, so gate the rest on having a body or queued comments.
  const needsContent = $derived(event !== "APPROVE" && drafts.length === 0);
  const hasContent = $derived(body.trim().length > 0);
  const canSubmit = $derived(!submitting && (!needsContent || hasContent));

  // The form owns the second press: ⌥A first selects Approve, then confirms it.
  // Its exclusive scope keeps the underlying diff panel from seeing the keystroke.
  useScope("pr-review", { exclusive: true });
  useKeybinding("pr-review.approve", () => {
    if (!allowedVerdicts.includes("approve")) return;
    if (event !== "APPROVE") {
      event = "APPROVE";
      return;
    }
    if (canSubmit) void submit();
  });
</script>

<ReviewComposer bind:value={event} bind:body {choices} busy={submitting} {canSubmit} {needsContent} onSubmit={() => void submit()}>
  {#snippet comments()}
    {#if drafts.length > 0}
      <ul
        aria-label="{drafts.length} line {drafts.length === 1 ? 'comment' : 'comments'} included"
        class="flex max-h-48 flex-col gap-1 overflow-y-auto overscroll-contain"
      >
        {#each drafts as d (d.id)}
          <!-- Long comments clamp to two lines; the tooltip carries the full text. -->
          <li class="flex min-w-0 items-baseline gap-2 px-1 py-1 text-workspace-chrome" title="{d.path}:{d.line}&#10;{d.body}">
            <span class="max-w-[40%] shrink-0 truncate font-mono text-muted-foreground">{d.path.split("/").pop()}:{d.line}</span>
            <span class="line-clamp-2 min-w-0 flex-1 break-words text-foreground">{d.body}</span>
          </li>
        {/each}
      </ul>
    {/if}

  {/snippet}
  {#snippet hint()}
    {#if needsContent && !hasContent}Add a summary or a line comment{/if}
  {/snippet}
  {#snippet actions()}
    {#if event === "REQUEST_CHANGES" && !pr.headRepo.isFork && onDraftFixes}
      <Button variant="outline" size="sm" disabled={!canSubmit} onclick={() => void submit(true)}>
        Submit & draft fixes
      </Button>
    {/if}
  {/snippet}
</ReviewComposer>
