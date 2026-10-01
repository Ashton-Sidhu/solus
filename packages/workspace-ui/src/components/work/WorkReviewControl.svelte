<script lang="ts">
  import { untrack } from "svelte";
  import { Check as CheckIcon, Link as LinkIcon, RotateCw as RerequestIcon, Send as SendIcon, X as XIcon } from "@lucide/svelte";
  import { parseUserKey, userKey, type User } from "@solus/contracts/user";
  import type { WorkType } from "@solus/contracts/types";
  import type { WorkReviewDecision } from "@solus/contracts/work-review";
  import * as Popover from "../ui/popover";
  import { Button } from "../ui/button";
  import UserAvatar from "../users/UserAvatar.svelte";
  import { getClientShellContext, getSurfaceContext, presenceStore, sharesStore } from "../../contexts";
  import { getMentionContext } from "../mentions/lib/mention-context";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { getWorkPaneContext } from "./lib/work-pane-context";
  import WorkHistoryDialog from "./WorkHistoryDialog.svelte";
  import { copyWorkReviewLink } from "./lib/work-review-commands";
  import {
    DECISION_LABELS,
    openThreadsPrompt,
    ownReviewer,
    reviewCandidates,
    reviewerName,
    reviewerStatus,
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

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="inline-flex h-[1.625rem] min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-workspace-chrome text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border) pointer-coarse:h-10 pointer-coarse:px-3"
        data-testid="work-review"
        data-state={review?.state ?? "draft"}
        title="Review"
      >
        {#if reviewers.length > 0}
          <span class="inline-flex shrink-0 items-center -space-x-1">
            {#each reviewers.slice(0, 3) as reviewer (reviewer.reviewerId)}
              <UserAvatar user={reviewerUser(reviewer.reviewerId, reviewerName(reviewer, people))} size={16} class="ring-[1.5px] ring-background" />
            {/each}
          </span>
        {/if}
        <span class="truncate {review?.state === 'approved' ? 'text-(--solus-diff-added-text)' : review?.state === 'changes_requested' ? 'text-(--solus-diff-removed-text)' : ''}">
          {review && review.state !== "draft" ? reviewStateLabel(review.state) : "Review"}
        </span>
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content align="end" sideOffset={6} class="flex max-h-[min(36rem,calc(100dvh-4rem))] w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto p-3 text-workspace-chrome">
    <div class="flex items-center justify-between gap-2">
      <span class="font-medium text-(--solus-text-primary)">Review</span>
      <span class="text-(--solus-text-tertiary)">{reviewStateLabel(review?.state ?? "draft")}</span>
    </div>

    {#if reviewers.length === 0}
      <p class="text-(--solus-text-secondary)">Nobody reviews this work yet. Review is information only: it blocks nothing.</p>
    {:else}
      <ul class="flex flex-col gap-2" aria-label="Reviewers">
        {#each reviewers as reviewer (reviewer.reviewerId)}
          {@const name = reviewerName(reviewer, people)}
          <li class="flex min-w-0 items-start gap-2">
            <UserAvatar user={reviewerUser(reviewer.reviewerId, name)} size={20} class="mt-0.5" />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-(--solus-text-primary)">{name}{reviewer.reviewerId === selfKey ? " (you)" : ""}</span>
              <span class="truncate {reviewer.decision === 'approved' && !reviewer.isStale ? 'text-(--solus-diff-added-text)' : reviewer.decision === 'changes_requested' && !reviewer.isStale ? 'text-(--solus-diff-removed-text)' : 'text-(--solus-text-tertiary)'}">{reviewerStatus(reviewer)}</span>
              {#if reviewer.decisionSummary}
                <p class="mt-0.5 line-clamp-3 text-(--solus-text-secondary)">{reviewer.decisionSummary}</p>
              {/if}
            </div>
            {#if canManage}
              <div class="flex shrink-0 items-center">
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

    {#if mine?.decidedRevisionId && mine.isStale}
      <Button variant="outline" size="sm" class="justify-start pointer-coarse:min-h-11" onclick={() => { open = false; historyOpen = true; }}>
        Changes since my last review
      </Button>
    {/if}

    {#if canDecide && pane}
      <section class="flex flex-col gap-2 border-t border-(--solus-tool-border) pt-3" aria-label="Your review">
        <div class="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Decision">
          {#each Object.entries(DECISION_LABELS) as [value, label] (value)}
            <button
              type="button"
              role="radio"
              aria-checked={decision === value}
              class="min-w-0 overflow-hidden rounded-md border px-1.5 py-1 text-center pointer-coarse:min-h-11 {decision === value ? 'border-(--solus-accent-border) bg-(--solus-accent-light) text-(--solus-text-primary)' : 'border-(--solus-tool-border) text-(--solus-text-secondary) hover:bg-(--solus-surface-hover)'}"
              onclick={() => (decision = value as WorkReviewDecision)}
            >
              <span class="block truncate">{label}</span>
            </button>
          {/each}
        </div>
        <textarea
          bind:value={summary}
          rows="2"
          maxlength="4000"
          placeholder="Summary (optional)"
          class="w-full resize-y rounded-md border border-(--solus-tool-border) bg-transparent px-2 py-1.5 text-(--solus-text-primary) placeholder:text-(--solus-text-tertiary) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border)"
          onkeydown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitDecision(); }}
        ></textarea>
        <Button size="sm" class="pointer-coarse:min-h-11" disabled={busy} data-testid="work-review-submit" onclick={submitDecision}>
          <CheckIcon size={13} />
          {mine?.decision ? "Update review" : "Submit review"}
        </Button>
      </section>
    {/if}

    {#if canManage}
      <section class="flex flex-col gap-2 border-t border-(--solus-tool-border) pt-3" aria-label="Request review">
        {#if people}
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
        {:else}
          <p class="text-(--solus-text-secondary)">This work has no organization to ask. Copy a review link for people outside it.</p>
        {/if}
        <div class="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" disabled={busy} data-testid="work-review-link" onclick={() => { open = false; void copyWorkReviewLink(serverId, workId, title); }}>
            <LinkIcon size={13} />
            Copy review link
          </Button>
          {#if session.workspace && shell.canOpenResource("chat")}
            <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" disabled={busy} onclick={sendOpenComments}>
              <SendIcon size={13} />
              Send open comments to agent
            </Button>
          {/if}
        </div>
      </section>
    {/if}
  </Popover.Content>
</Popover.Root>

{#if historyOpen && mine?.decidedRevisionId}
  <WorkHistoryDialog bind:open={historyOpen} {workId} {title} {type} {currentContent} initialPick="current" initialBase={mine.decidedRevisionId} />
{/if}
