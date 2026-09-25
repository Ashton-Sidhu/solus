<script lang="ts">
  import {
    MessageSquareText as ChatTextIcon,
    CircleCheck as CheckCircleIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import { CommentEditor } from "../ui/comment-editor";
  import type { PrReviewTarget, PrReviewVerdict } from "@solus/contracts/providers";
  import type { DraftReview, DraftReviewComment } from "@solus/contracts/providers";
  import type { ReviewDraftComment } from "@solus/contracts/review";
  import { toasts } from "../../lib/toasts";
  import { isMac } from "../../lib/keybindings/match";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { Button } from "../ui/button";
  import Kbd from "../ui/Kbd.svelte";
  import EditorVoiceControl from "../input/EditorVoiceControl.svelte";
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

  // Each verdict carries its own semantic color, fed through `--ev` so the
  // selected segment's icon and the submit button agree: approve = go,
  // request changes = stop.
  const EVENTS: {
    id: DraftReview["event"];
    label: string;
    icon: typeof ChatTextIcon;
    color: string;
  }[] = [
    { id: "COMMENT", label: "Comment", icon: ChatTextIcon, color: "var(--solus-accent)" },
    { id: "APPROVE", label: "Approve", icon: CheckCircleIcon, color: "var(--solus-status-complete)" },
    { id: "REQUEST_CHANGES", label: "Request changes", icon: WarningCircleIcon, color: "var(--solus-status-error)" },
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
  const hasBlockedVerdicts = $derived(availableEvents.length < shownEvents.length);
  const selectedEvent = $derived(EVENTS.find((reviewEvent) => reviewEvent.id === event) ?? EVENTS[0]);

  let submitting = $state(false);

  // The summary is what you came here to write, so it takes focus on open.
  let bodyEditor: ReturnType<typeof CommentEditor> | null = $state(null);
  let bodyFocused = $state(false);
  $effect(() => {
    bodyEditor?.focus();
  });
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

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
      e.preventDefault();
      void submit();
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex flex-col gap-3 p-3" onkeydown={onKeydown}>
  <CommentEditor
    bind:this={bodyEditor}
    value={body}
    onValueChange={(md) => (body = md)}
    onFocus={() => (bodyFocused = true)}
    onBlur={() => (bodyFocused = false)}
    mic={false}
    maxHeight={220}
    ariaLabel="Review summary"
    placeholder={needsContent ? "Write a summary…" : "Add a summary (optional)…"}
    class="rounded-xl border border-border bg-transparent px-2.5 transition-colors focus-within:border-ring [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![padding:0.5rem_0] [&_.cm-content]:![font-weight:400]"
  />

  {#if shownEvents.length > 1}
    <div class="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label="Verdict" class="flex gap-0.5 rounded-lg bg-muted p-0.5">
        {#each shownEvents as reviewEvent (reviewEvent.id)}
          {@const selected = event === reviewEvent.id}
          {@const blocked = !availableEvents.includes(reviewEvent)}
          {@const Icon = reviewEvent.icon}
          <label
            style="--ev:{reviewEvent.color};"
            title={blocked ? `You can't ${reviewEvent.label.toLowerCase()} on this pull request` : undefined}
            class="flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-md px-2 py-1.5 text-workspace-chrome transition-colors pointer-coarse:py-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring {selected
              ? 'bg-background font-medium text-foreground shadow-xs'
              : blocked
                ? 'cursor-not-allowed text-muted-foreground opacity-50'
                : 'cursor-pointer text-muted-foreground hover:text-foreground'}"
          >
            <input type="radio" name="review-event" value={reviewEvent.id} bind:group={event} disabled={blocked} class="sr-only" />
            <Icon class="size-3.5 shrink-0 {selected ? 'text-(--ev)' : ''}" aria-hidden="true" />
            <span class="truncate">{reviewEvent.label}</span>
          </label>
        {/each}
      </div>
      {#if hasBlockedVerdicts}
        <!-- GitHub, the only host today, blocks these for the PR's author. -->
        <p class="text-workspace-chrome text-muted-foreground">
          Authors can't approve or request changes on their own pull request.
        </p>
      {/if}
    </div>
  {/if}

  {#if drafts.length > 0}
    <div class="flex flex-col gap-1">
      <span class="text-workspace-chrome text-muted-foreground">
        {drafts.length} line {drafts.length === 1 ? "comment" : "comments"} included
      </span>
      <ul class="flex max-h-32 flex-col overflow-y-auto overscroll-contain rounded-lg border border-border">
        {#each drafts as d (d.id)}
          <li class="flex min-w-0 items-baseline gap-2 border-b border-border px-2.5 py-1.5 text-workspace-chrome last:border-b-0" title="{d.path}:{d.line}">
            <span class="max-w-[45%] shrink-0 truncate font-mono text-muted-foreground">{d.path.split("/").pop()}:{d.line}</span>
            <span class="min-w-0 flex-1 truncate text-foreground">{d.body}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <footer class="flex items-center gap-2">
    <span class="min-w-0 flex-1 truncate text-workspace-chrome text-muted-foreground">
      {#if needsContent && !hasContent}
        Add a summary or a line comment
      {:else}
        <span class="pointer-coarse:hidden"><Kbd variant="keycap">{isMac ? "⌘" : "Ctrl"}↵</Kbd></span>
      {/if}
    </span>
    {#if event === "REQUEST_CHANGES" && !pr.headRepo.isFork && onDraftFixes}
      <Button variant="outline" size="sm" disabled={!canSubmit} onclick={() => void submit(true)}>
        Submit & draft fixes
      </Button>
    {/if}
    <!-- The mic sits with the submit button, as in the comment composer, so
         the summary field keeps its full width. -->
    <span class="flex shrink-0 items-center">
      <EditorVoiceControl
        onTranscript={(transcript) => bodyEditor?.insertTranscript(transcript)}
        focused={bodyFocused}
        disabled={submitting}
      />
    </span>
    <Button
      size="sm"
      style="--ev:{selectedEvent.color};"
      class="bg-(--ev) text-white hover:bg-(--ev) hover:opacity-90"
      disabled={!canSubmit}
      onclick={() => void submit()}
    >
      {submitting ? "Submitting…" : selectedEvent.label}
    </Button>
  </footer>
</div>
