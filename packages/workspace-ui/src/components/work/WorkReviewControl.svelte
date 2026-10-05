<script lang="ts">
  import { untrack } from "svelte";
  import { GitCompare as CompareIcon, Link as LinkIcon, MessageSquareCheck as ReviewIcon, RotateCw as RerequestIcon, Send as SendIcon, X as XIcon } from "@lucide/svelte";
  import { parseUserKey, userKey, type User } from "@solus/contracts/user";
  import type { WorkType } from "@solus/contracts/types";
  import type { WorkReviewDecision } from "@solus/contracts/work-review";
  import * as Popover from "../ui/popover";
  import * as TooltipUI from "../ui/tooltip";
  import { Button } from "../ui/button";
  import CommentBody from "../comments/CommentBody.svelte";
  import UserAvatar from "../users/UserAvatar.svelte";
  import { getClientShellContext, getSurfaceContext, presenceStore, sharesStore } from "../../contexts";
  import { getMentionContext } from "../mentions/lib/mention-context";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { getWorkPaneContext } from "./lib/work-pane-context";
  import ReviewComposer from "../ui/review-composer/ReviewComposer.svelte";
  import type { ReviewChoice } from "../ui/review-composer/lib/review-choice";
  import WorkHistoryDialog from "./WorkHistoryDialog.svelte";
  import ReviewerAvatars from "./ReviewerAvatars.svelte";
  import ReviewDecisionIcon from "./ReviewDecisionIcon.svelte";
  import { copyWorkReviewLink } from "./lib/work-review-commands";
  import {
    openThreadsPrompt,
    ownReviewer,
    reviewCandidates,
    reviewerActivity,
    reviewerName,
    reviewStateLabel,
  } from "./lib/work-review";

  interface Props {
    workId: string;
    title: string;
    type: WorkType;
    /** The body on screen now, for the "changes since my last review" comparison. */
    currentContent: () => string;
  }

  let { workId, title, type, currentContent }: Props = $props();

  const session = getSurfaceContext();
  const shell = getClientShellContext();
  const pane = getWorkPaneContext();
  const mentions = getMentionContext();
  const reviews = session.worksStore.reviews;

  const serverId = $derived(session.worksStore.hostFor(workId));
  const review = $derived(reviews.reviews.get(workId) ?? null);
  const people = $derived(mentions.directory());
  const selfId = $derived(serverId ? presenceStore.currentUserId(serverId) : null);
  const selfKey = $derived(selfId ? userKey(selfId) : null);
  const role = $derived(serverId ? sharesStore.listFor(serverId, { kind: "work", id: workId })?.callerRole : undefined);
  // No share list is a host that keeps none: its owner.
  const canManage = $derived(role === undefined || role === "owner" || role === "editor");
  const canDecide = $derived(!!selfKey && role !== "viewer" && role !== "none");
  const mine = $derived(ownReviewer(review, selfKey));
  const reviewers = $derived(review?.reviewers ?? []);

  const choices: ReviewChoice<WorkReviewDecision>[] = [
    { value: "commented", label: "Comment", kind: "comment" },
    { value: "approved", label: "Approve", kind: "approve" },
    { value: "changes_requested", label: "Request changes", kind: "request-changes" },
  ];

  let open = $state(false);
  let query = $state("");
  let chosen = $state<User[]>([]);
  let message = $state("");
  let decision = $state<WorkReviewDecision>("approved");
  let summary = $state("");
  let busy = $state(false);
  let historyOpen = $state(false);

  const candidates = $derived(open && canManage ? reviewCandidates(people, review, selfKey, query).filter((member) => !chosen.some((picked) => userKey(picked.id) === userKey(member.id))).slice(0, 6) : []);

  // The review is read while the header is mounted; the store reads it again
  // on every change.
  $effect(() => {
    const id = workId;
    untrack(() => void reviews.load(id));
  });
  // A gallery or palette command asked for the popover.
  $effect(() => {
    if (reviews.pendingOpen === workId && untrack(() => reviews.takePendingOpen(workId))) open = true;
  });

  function reviewerUser(reviewerId: string, name: string): User {
    return { id: parseUserKey(reviewerId), displayName: name };
  }

  async function run(action: () => Promise<void>, done?: string) {
    if (busy) return;
    busy = true;
    try {
      await action();
      if (done) toasts.success(done);
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  }

  function requestReview(targets: { userId: string; displayName: string }[]) {
    if (!pane || targets.length === 0) return;
    if (pane.isDirty()) {
      toasts.error("Save your edits first, so reviewers see them.");
      return;
    }
    void run(async () => {
      await reviews.request(workId, { reviewers: targets, message: message.trim() || undefined, expectedContentVersion: await pane.contentVersion() });
      chosen = [];
      message = "";
      query = "";
    }, targets.length === 1 ? `Review requested from ${targets[0].displayName}` : `Review requested from ${targets.length} people`);
  }

  function submitDecision() {
    if (!pane) return;
    if (pane.isDirty()) {
      toasts.error("Save your edits first: a decision applies to the saved version.");
      return;
    }
    void run(async () => {
      await reviews.decide(workId, { target: { kind: "current", contentVersion: await pane.contentVersion() }, decision, summary: summary.trim() || undefined });
      summary = "";
      open = false;
      requestInputFocus();
    }, decision === "approved" ? "Approved" : decision === "changes_requested" ? "Changes requested" : "Review sent");
  }


  function sendOpenComments() {
    const prompt = openThreadsPrompt(title, workId, session.worksStore.annotationComments(workId));
    if (!prompt) {
      toasts.info("There are no open comments to send.");
      return;
    }
    const workspace = session.workspace;
    if (!workspace) return;
    open = false;
    void run(async () => { await workspace.sendMessageToWorkSession(workId, prompt); });
  }
</script>

<!-- The button shows the review as icons: the reviewers' avatars, ringed
     faintly in their verdict color, then the overall state. Hover on the
     avatars names who did what. -->
<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="inline-flex h-6.5 min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-full bg-background px-2.5 text-workspace-chrome text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-colors hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-(--solus-accent-border) pointer-coarse:h-10 pointer-coarse:px-3"
        data-testid="work-review"
        data-state={review?.state ?? "draft"}
        aria-label="Review: {reviewStateLabel(review?.state ?? 'draft')}"
      >
        <ReviewerAvatars {reviewers} nameOf={(reviewer) => reviewerName(reviewer, people)} />
        {#if !review || review.state === "draft"}
          <ReviewIcon size={15} strokeWidth={1.5} class="shrink-0" aria-hidden="true" />
          <span class="truncate">Review</span>
        {:else}
          <ReviewDecisionIcon decision={review.state === "approved" ? "approved" : review.state === "changes_requested" ? "changes_requested" : null} size={15} />
        {/if}
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    align="end"
    sideOffset={6}
    collisionPadding={8}
    aria-label="Review work"
    class="flex max-h-[min(48rem,calc(100dvh-2rem))] w-[min(34rem,calc(100vw-1rem))] flex-col gap-3 overflow-y-auto overscroll-contain rounded-2xl border-[0.0313rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-4 text-workspace-chrome shadow-[shadow:var(--solus-popover-shadow)] ring-0"
    onOpenAutoFocus={(event) => { if (canDecide && pane) event.preventDefault(); }}
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      if (!document.activeElement || document.activeElement === document.body) requestInputFocus();
    }}
  >
    <!-- The work's review commands share the header row, as icons. -->
    <div class="flex items-center gap-2">
      <span class="font-medium text-(--solus-text-primary)">Review</span>
      <span class="flex-1"></span>
      <div class="flex shrink-0 items-center gap-0.5">
        {#if mine?.decidedRevisionId && mine.isStale}
          {@render headerAction("Changes since my last review", CompareIcon, () => { open = false; historyOpen = true; })}
        {/if}
        {#if canManage}
          {@render headerAction("Copy review link", LinkIcon, () => { open = false; void copyWorkReviewLink(serverId, workId, title); }, "work-review-link")}
          {#if session.workspace && shell.canOpenResource("chat")}
            {@render headerAction("Send open comments to agent", SendIcon, sendOpenComments)}
          {/if}
        {/if}
      </div>
    </div>

    {#if reviewers.length === 0}
      <p class="text-(--solus-text-secondary)">Nobody reviews this work yet. Review is information only: it blocks nothing.</p>
    {:else}
      <ul class="flex flex-col gap-2" aria-label="Reviewers">
        {#each reviewers as reviewer (reviewer.reviewerId)}
          {@const name = reviewerName(reviewer, people)}
          {@const activity = reviewerActivity(reviewer)}
          <li class="group/reviewer flex min-w-0 items-start gap-2.5">
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <span {...props} class="relative mt-0.5 shrink-0">
                    <UserAvatar user={reviewerUser(reviewer.reviewerId, name)} size={24} />
                    <span class="absolute -right-1 -bottom-1 flex rounded-full bg-(--solus-popover-bg) p-px">
                      <ReviewDecisionIcon decision={reviewer.decision} isStale={reviewer.isStale} size={12} />
                    </span>
                  </span>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value={activity} />
            </TooltipUI.Root>
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="flex min-w-0 items-baseline gap-1.5">
                <span class="truncate text-(--solus-text-primary)">{name}{reviewer.reviewerId === selfKey ? " (you)" : ""}</span>
                <span class="sr-only">{activity}</span>
                {#if reviewer.isAwaiting && reviewer.decision}
                  <span class="shrink-0 text-(--solus-text-tertiary)" aria-hidden="true">· asked again</span>
                {/if}
              </span>
              {#if reviewer.decisionSummary}
                <div class="mt-0.5"><CommentBody text={reviewer.decisionSummary} clamp /></div>
              {/if}
            </div>
            {#if canManage}
              <div class="flex shrink-0 items-center opacity-0 transition-opacity group-hover/reviewer:opacity-100 group-focus-within/reviewer:opacity-100 pointer-coarse:opacity-100">
                {#if reviewer.decision && !reviewer.isAwaiting && !reviewer.reviewerId.startsWith("guest:")}
                  <Button variant="ghost" size="icon-xs" class="pointer-coarse:size-10" aria-label={`Request review from ${name} again`} title="Request review again" disabled={busy} onclick={() => requestReview([{ userId: reviewer.reviewerId, displayName: name }])}>
                    <RerequestIcon size={13} />
                  </Button>
                {/if}
                <Button variant="ghost" size="icon-xs" class="pointer-coarse:size-10" aria-label={`Remove ${name} as a reviewer`} title="Remove reviewer" disabled={busy} onclick={() => void run(async () => { await reviews.remove(workId, reviewer.reviewerId); })}>
                  <XIcon size={13} />
                </Button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if canDecide && pane}
      <section class="border-t border-(--solus-tool-border) pt-3" aria-label="Your review">
        <ReviewComposer
          bind:value={decision}
          bind:body={summary}
          {choices}
          busy={busy}
          maxLength={4000}
          submitLabel={mine?.decision ? "Update review" : undefined}
          submitTestId="work-review-submit"
          onSubmit={submitDecision}
          class="p-0"
        />
      </section>
    {/if}

    {#if canManage && people}
      <section class="flex flex-col gap-2 border-t border-(--solus-tool-border) pt-3" aria-label="Request review">
        {#if chosen.length > 0}
          <div class="flex flex-wrap gap-1">
            {#each chosen as person (userKey(person.id))}
              <span class="inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full border border-(--solus-tool-border) py-0.5 pr-1 pl-0.5">
                <UserAvatar user={person} size={16} />
                <span class="truncate">{person.displayName}</span>
                <button type="button" class="shrink-0 rounded-full text-(--solus-text-tertiary) hover:text-(--solus-text-primary)" aria-label={`Remove ${person.displayName}`} onclick={() => (chosen = chosen.filter((other) => userKey(other.id) !== userKey(person.id)))}>
                  <XIcon size={12} />
                </button>
              </span>
            {/each}
          </div>
        {/if}
        <input
          bind:value={query}
          type="search"
          placeholder="Add reviewers from {people.name}"
          aria-label="Find a reviewer"
          class="h-8 w-full rounded-md border border-(--solus-tool-border) bg-transparent px-2 text-(--solus-text-primary) placeholder:text-(--solus-text-tertiary) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border) pointer-coarse:h-11"
          onkeydown={(event) => {
            if (event.key === "Enter" && candidates[0]) {
              event.preventDefault();
              chosen = [...chosen, candidates[0]];
              query = "";
            }
          }}
        />
        {#if query && candidates.length > 0}
          <ul class="flex flex-col" aria-label="Members">
            {#each candidates as member (userKey(member.id))}
              <li>
                <button type="button" class="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-left hover:bg-(--solus-surface-hover) pointer-coarse:min-h-11" onclick={() => { chosen = [...chosen, member]; query = ""; }}>
                  <UserAvatar user={member} size={18} />
                  <span class="truncate text-(--solus-text-primary)">{member.displayName}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if chosen.length > 0}
          <textarea
            bind:value={message}
            rows="2"
            maxlength="2000"
            placeholder="Message (optional)"
            class="w-full resize-y rounded-md border border-(--solus-tool-border) bg-transparent px-2 py-1.5 text-(--solus-text-primary) placeholder:text-(--solus-text-tertiary) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border)"
          ></textarea>
          <Button size="sm" class="pointer-coarse:min-h-11" disabled={busy} data-testid="work-review-request" onclick={() => requestReview(chosen.map((person) => ({ userId: userKey(person.id), displayName: person.displayName })))}>
            Request review
          </Button>
        {/if}
      </section>
    {/if}
  </Popover.Content>
</Popover.Root>

{#if historyOpen && mine?.decidedRevisionId}
  <WorkHistoryDialog bind:open={historyOpen} {workId} {title} {type} {currentContent} initialPick="current" initialBase={mine.decidedRevisionId} />
{/if}

{#snippet headerAction(label: string, Icon: typeof LinkIcon, onclick: () => void, testId?: string)}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-xs" class="rounded-full pointer-coarse:size-10" aria-label={label} disabled={busy} data-testid={testId} {onclick}>
          <Icon size={14} />
        </Button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={label} />
  </TooltipUI.Root>
{/snippet}
