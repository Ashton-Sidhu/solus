<script lang="ts">
  import { CircleNotchIcon, GitBranchIcon } from "phosphor-svelte";
  import type { PrReviewTarget } from "@solus/contracts/providers";
  import type { PrReviewState } from "./lib/pr-review.store.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";

  // Explicit checkout UI for a pull request review: two destinations. A
  // separate worktree is first and recommended — it reuses whatever checkout
  // already exists or the deterministic PR worktree/branch convention, and
  // never touches the project the review was opened from. Checking out in the
  // current repository instead switches that one working copy onto the PR's
  // branch, so it is explicit (its own menu row) and confirmed (a second step)
  // rather than a single click.
  let {
    pr,
    review,
    onOpenWorktree,
    onCheckoutHere,
  }: {
    pr: PrReviewTarget | null;
    review: PrReviewState;
    onOpenWorktree: () => void;
    onCheckoutHere: () => void;
  } = $props();

  let open = $state(false);
  let confirming = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  const busy = $derived(review.repoCheckoutStatus === "preparing");

  function chooseWorktree(): void {
    open = false;
    onOpenWorktree();
  }

  function askToCheckOutHere(): void {
    open = false;
    confirming = true;
  }

  function cancelConfirm(): void {
    if (busy) return;
    confirming = false;
  }

  function confirmCheckoutHere(): void {
    onCheckoutHere();
  }

  // A completed checkout closes the confirm step on its own; a failure stays
  // open so the reason (stale head, dirty tree, branch in use…) is visible
  // beside the retry.
  $effect(() => {
    if (review.repoCheckoutStatus === "ready") confirming = false;
  });
</script>

<Button
  bind:ref={triggerEl}
  variant="ghost"
  size="icon-sm"
  disabled={!pr}
  aria-label="Check out this pull request"
  aria-haspopup="menu"
  aria-expanded={open}
  title="Check out this pull request"
  onclick={() => (open = !open)}
>
  <GitBranchIcon size={14} weight="bold" />
</Button>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-72"
  >
    <DropdownMenu.Item onSelect={chooseWorktree}>
      <span class="flex flex-1 items-center justify-between gap-2">
        Open in a separate worktree
        <span class="text-xs text-(--solus-text-tertiary)">Recommended</span>
      </span>
    </DropdownMenu.Item>
    <DropdownMenu.Item onSelect={askToCheckOutHere}>
      Check out in current repository…
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

{#if confirming}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    data-solus-ui
    class="fixed inset-0 z-[10008] flex items-start justify-center pt-[18vh] pointer-events-auto bg-transparent"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) cancelConfirm();
    }}
    onkeydown={(e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelConfirm();
      }
    }}
  >
    <div
      class="flex w-[clamp(18rem,38vw,26rem)] max-w-[calc(100vw-3rem)] flex-col gap-3 rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-[1.125rem] shadow-[var(--solus-popover-shadow)]"
      role="dialog"
      aria-label="Check out in current repository"
      aria-modal="true"
    >
      <div class="flex flex-col gap-1">
        <span class="text-sm font-medium">
          Check out PR #{pr?.number} here?
        </span>
        <span class="text-xs text-(--solus-text-tertiary)">
          This switches the project's repository to the pull request's
          branch. A fresh draft opens there — the conversation you're in now
          keeps running where it is.
        </span>
      </div>
      {#if review.repoCheckoutStatus === "failed" && review.repoCheckoutError}
        <p class="text-xs text-(--solus-danger,#e5484d)">
          {review.repoCheckoutError}
        </p>
      {/if}
      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onclick={cancelConfirm}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onclick={confirmCheckoutHere}>
          {#if busy}
            <CircleNotchIcon size={13} class="animate-spin" />
            Checking out…
          {:else}
            Check out
          {/if}
        </Button>
      </div>
    </div>
  </div>
{/if}
