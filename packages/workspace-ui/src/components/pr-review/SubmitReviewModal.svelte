<script lang="ts">
  import {
    X as XIcon,
    MessageSquareText as ChatTextIcon,
    CircleCheck as CheckCircleIcon,
    CircleAlert as WarningCircleIcon,
    Check as CheckIcon,
    Send as PaperPlaneTiltIcon,
  } from "@lucide/svelte";
  import { CommentEditor } from "../ui/comment-editor";
  import type { IpcContext } from "@solus/contracts/types";
  import type { PrReviewTarget, PrReviewVerdict } from "@solus/contracts/providers";
  import type { DraftReview, DraftReviewComment } from "@solus/contracts/providers";
  import type { ReviewDraftComment } from "@solus/contracts/review";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { HostApi } from "@solus/client-core/host-api";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { Button } from "../ui/button";
  import type { PrFixFeedback } from "../../contexts/workspace/pr-fix-session";

  // The submit modal (decision #14): pick an event, write a summary body, review
  // the read-only queued comments, and fire one prSubmitReview anchored to the
  // PR head SHA. On success the parent clears the draft store. Event + body are
  // bindable so the host owns them — Esc/close no longer destroys a typed
  // summary; it's there again on reopen.
  let {
    pr,
    drafts,
    event = $bindable("COMMENT"),
    body = $bindable(""),
    onClose,
    onSubmitted,
    getCtx,
    getApi,
    onSendToFixAgent,
    allowedVerdicts,
  }: {
    pr: PrReviewTarget;
    drafts: ReviewDraftComment[];
    event?: DraftReview["event"];
    body?: string;
    onClose: () => void;
    onSubmitted: () => void;
    /** Context override so embedded hosts can submit against the PR's own
     *  project rather than the active tab's. Defaults to the active tab. */
    getCtx?: () => IpcContext;
    getApi: () => HostApi;
    onSendToFixAgent?: (feedback: PrFixFeedback) => Promise<void>;
    allowedVerdicts: PrReviewVerdict[];
  } = $props();

  const session = getWorkspaceContext();

  // Each event carries its own semantic color so the selected card reads as
  // "approve = go / request changes = stop" at a glance. `color` drives the
  // ring + icon, `soft` the selected fill — both fed through CSS vars on the
  // label so we avoid conditional class soup.
  const EVENTS: {
    id: DraftReview["event"];
    label: string;
    hint: string;
    icon: typeof ChatTextIcon;
    color: string;
    soft: string;
  }[] = [
    {
      id: "COMMENT",
      label: "Comment",
      hint: "Leave feedback without explicit approval",
      icon: ChatTextIcon,
      color: "var(--solus-accent)",
      soft: "var(--solus-accent-soft)",
    },
    {
      id: "APPROVE",
      label: "Approve",
      hint: "Approve these changes",
      icon: CheckCircleIcon,
      color: "var(--solus-status-complete)",
      soft: "var(--solus-status-complete-bg)",
    },
    {
      id: "REQUEST_CHANGES",
      label: "Request changes",
      hint: "Block until the feedback is addressed",
      icon: WarningCircleIcon,
      color: "var(--solus-status-error)",
      soft: "var(--solus-status-error-bg)",
    },
  ];
  const eventVerdict = (reviewEvent: DraftReview["event"]): PrReviewVerdict =>
    reviewEvent === "APPROVE"
      ? "approve"
      : reviewEvent === "REQUEST_CHANGES"
        ? "request-changes"
        : "comment";
  const availableEvents = $derived(
    EVENTS.filter((reviewEvent) => allowedVerdicts.includes(eventVerdict(reviewEvent.id))),
  );

  let submitting = $state(false);

  // Move focus into the modal on open (keyboard-first: Tab must not land on
  // the surface behind, and the summary is what you came here to write).
  let bodyEditor: ReturnType<typeof CommentEditor> | null = $state(null);
  $effect(() => {
    bodyEditor?.focus();
  });
  $effect(() => {
    if (!availableEvents.some((reviewEvent) => reviewEvent.id === event)) {
      event = availableEvents[0]?.id ?? "COMMENT";
    }
  });

  // Markdown input styled like the message composer: transparent field, accent
  // focus ring, forced 400 weight so typed text never reads bold.
  // left:0.875rem lines the placeholder up with the editor text (the wrapper's
  // px-2.5 plus the ProseMirror's own 0.25rem left padding).
  const mdFieldClass =
    "rounded-lg border border-border bg-transparent px-2.5 transition-colors focus-within:border-ring [&_.cm-content]:![min-height:3rem] [&_.cm-content]:![padding:0.5rem_0] [&_.cm-content]:![font-weight:400]";

  async function submit(sendToFixAgent = false) {
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
      await getApi().prSubmitReview(
        getCtx?.() ?? session.ctx,
        pr.number,
        review,
      );
      body = "";
      onSubmitted();
      closeModal();
      toasts.success("Review submitted");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toasts.error("Submit failed", { description: message });
      return;
    } finally {
      submitting = false;
    }
    if (sendToFixAgent) {
      try {
        await onSendToFixAgent?.(feedback);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toasts.error("Review submitted, but the fix agent couldn't open", {
          description: message,
        });
      }
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
      e.preventDefault();
      void submit();
    }
  }

  function closeModal() {
    onClose();
    requestInputFocus();
  }

  // GitHub rejects a COMMENT or REQUEST_CHANGES review that carries neither a
  // summary body nor any inline comments with a bare 422 "Unprocessable Entity".
  // Only APPROVE may be empty, so gate the rest on having a body or queued comments.
  const needsContent = $derived(event !== "APPROVE");
  const canSubmit = $derived(
    !submitting && (!needsContent || body.trim().length > 0 || drafts.length > 0),
  );

  // The modal owns the second press: ⌥A first selects Approve, then confirms it.
  // Its exclusive scope keeps the underlying diff panel from seeing the modal keystroke.
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

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
>
  <div class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-(--solus-container-bg) shadow-2xl ring-1 ring-black/10 dark:ring-white/10">
    <header class="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-(--solus-accent-soft) text-primary">
        <PaperPlaneTiltIcon size={17} weight="fill" />
      </span>
      <div class="flex min-w-0 flex-col">
        <h2 class="text-sm font-medium ">
          Submit review
        </h2>
        <span class="text-xs text-muted-foreground">#{pr.number}</span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        class="ml-auto text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Close"
        onclick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          closeModal();
        }}
      >
        <XIcon size={15} />
      </Button>
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-xs font-medium r text-muted-foreground uppercase">Event</legend>
        {#each availableEvents as e (e.id)}
          {@const selected = event === e.id}
          {@const Icon = e.icon}
          <label
            style="--ev:{e.color}; --ev-soft:{e.soft};"
            class="group flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-(--ev) has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-(--solus-container-bg) {selected
 ? 'border-(--ev) bg-(--ev-soft)'
 : 'border-border hover:bg-muted'}"
          >
            <input type="radio" name="event" value={e.id} bind:group={event} class="sr-only" />
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-lg {selected
 ? 'bg-(--ev) text-white'
 : 'bg-muted text-muted-foreground'}"
            >
              <Icon size={17} weight={selected ? "fill" : "regular"} />
            </span>
            <span class="flex min-w-0 flex-col">
              <span class="text-sm font-medium text-foreground">{e.label}</span>
              <span class="text-xs text-muted-foreground">{e.hint}</span>
            </span>
            <span
              class="ml-auto flex size-5 shrink-0 items-center justify-center text-(--ev) {selected ? '' : 'opacity-0'}"
              aria-hidden="true"
            >
              <CheckIcon size={15} weight="bold" />
            </span>
          </label>
        {/each}
      </fieldset>

      <div class="flex flex-col gap-2">
        <span class="text-xs font-medium r text-muted-foreground uppercase">Summary</span>
        <CommentEditor
          bind:this={bodyEditor}
          value={body}
          onValueChange={(md) => (body = md)}
          enterInsertsNewline
          hidePlaceholderOnFocus
          maxHeight={180}
          placeholder={event === "APPROVE" || drafts.length > 0
            ? "Overall review comment (optional)…"
            : "Overall review comment (required without inline comments)…"}
          class={mdFieldClass}
        />
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium r text-muted-foreground uppercase">Queued comments</span>
          <span class="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-xs font-medium text-foreground tabular-nums">
            {drafts.length}
          </span>
        </div>
        {#if drafts.length === 0}
          <p class="rounded-2xl border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
            No inline comments — {event === "APPROVE" ? "this submits the summary only." : "a summary is required to submit."}
          </p>
        {:else}
          <ul class="flex flex-col gap-1.5">
            {#each drafts as d (d.id)}
              <li class="rounded-2xl border border-border bg-card px-3 py-2.5">
                <div class="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <span class="truncate">{d.path}:{d.line}</span>
                  <span class="shrink-0 rounded bg-muted px-1 py-px text-xs font-medium text-foreground">
                    {d.side === "old" ? "LEFT" : "RIGHT"}
                  </span>
                </div>
                <p class="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-foreground">{d.body}</p>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

    </div>

    <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3.5">
      <Button variant="ghost" onclick={closeModal}>
        Cancel
      </Button>
      <Button
        disabled={!canSubmit}
        onclick={() => void submit()}
      >
        <PaperPlaneTiltIcon data-icon="inline-start" weight="bold" />
        {submitting ? "Submitting…" : "Submit review"}
      </Button>
      {#if event === "REQUEST_CHANGES" && !pr.headRepo.isFork}
        <Button
          disabled={!canSubmit}
          class="bg-(--solus-status-error) text-white hover:opacity-90"
          onclick={() => void submit(true)}
        >
          <WarningCircleIcon data-icon="inline-start" weight="fill" />
          {submitting ? "Submitting…" : "Submit & send to fix agent"}
        </Button>
      {/if}
    </footer>
  </div>
</div>
