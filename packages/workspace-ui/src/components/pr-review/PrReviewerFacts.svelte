<script lang="ts">
  import {
    LoaderCircle as CircleNotchIcon,
    RotateCw as RotateIcon,
    UserRoundPlus as UserPlusIcon,
    Users as UsersIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { PrReviewer, PrReviewerCandidate } from "@solus/contracts/providers";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Skeleton } from "../ui/skeleton";
  import ReviewerRequestMenu from "./ReviewerRequestMenu.svelte";
  import {
    reviewerRingColor,
    reviewerRowAction,
    reviewerStateLabel,
  } from "./lib/reviewer-state";

  /**
   * The reviewers as one row of the facts list, for the pane too narrow to
   * keep the rail's column. Avatars with a verdict ring, and the same two
   * moves the rail's rows offer: the add-person glyph asks someone new, and
   * each avatar opens a menu with the one thing you can do to that person —
   * take a pending request back, or ask someone who has answered to look
   * again. A menu rather than a hover control, because the narrow pane is as
   * often a thumb as a pointer.
   *
   * Renders a `dt` and a `dd`, so it lives inside PrChangeFacts's list and
   * shares its caption column.
   */
  let {
    reviewers,
    loading,
    loadFailed = false,
    candidates = [],
    candidatesLoading = false,
    candidatesLoadFailed = false,
    mutation = null,
    onOpenMenu,
    onRequest,
    onRemove,
    onRetry,
  }: {
    reviewers: PrReviewer[];
    loading: boolean;
    loadFailed?: boolean;
    candidates?: PrReviewerCandidate[];
    candidatesLoading?: boolean;
    candidatesLoadFailed?: boolean;
    mutation?: string | null;
    onOpenMenu?: () => void;
    /** Absent when the viewer may not touch review requests, which hides the
     *  add control and the per-person menus rather than showing dead ones. */
    onRequest?: (login: string) => void;
    onRemove?: (login: string) => void;
    onRetry?: () => void;
  } = $props();

  let menuOpen = $state(false);
  let addTrigger = $state<HTMLButtonElement | null>(null);

  function handleMenuOpenChange(open: boolean): void {
    menuOpen = open;
    if (open) onOpenMenu?.();
  }

  /** The one action a reviewer's menu offers, and the handler that carries it
   *  out — null when the viewer may not touch review requests. */
  function reviewerAction(reviewer: PrReviewer) {
    const action = reviewerRowAction(reviewer.state);
    const run = action.kind === "remove" ? onRemove : onRequest;
    return run ? { ...action, run } : null;
  }
</script>

<dt class="flex items-center gap-2">
  <UsersIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
  Reviewers
</dt>
<dd class="flex min-h-6 min-w-0 flex-wrap items-center gap-1.5">
  {#if loading}
    <Skeleton class="size-6 rounded-full bg-muted" />
  {:else if loadFailed}
    <span>Couldn’t load reviewers.</span>
    {#if onRetry}
      <button
        type="button"
        class="cursor-pointer rounded-md px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-[var(--wash-2)]"
        onclick={onRetry}
      >
        Retry
      </button>
    {/if}
  {:else}
    {#each reviewers as reviewer (reviewer.login)}
      {@const ring = reviewerRingColor(reviewer.state)}
      {@const action = reviewerAction(reviewer)}
      {@const busy = mutation === reviewer.login}
      {@const verdict = reviewerStateLabel(reviewer.state)}
      {#if action}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full transition-[outline-color] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {ring
                  ? 'outline-2 -outline-offset-0 outline-[var(--reviewer-ring)]'
                  : 'hover:outline-2 hover:-outline-offset-0 hover:outline-[var(--hairline-strong)]'}"
                style={ring ? `--reviewer-ring:${ring}` : undefined}
                title={`${reviewer.login} · ${verdict}`}
                aria-label={`${reviewer.login}, ${verdict}`}
              >
                {#if busy}
                  <CircleNotchIcon
                    size={12}
                    class="animate-spin text-muted-foreground [animation-duration:0.9s]"
                  />
                {:else}
                  <PrAvatar
                    name={reviewer.login}
                    url={reviewer.avatarUrl ?? ""}
                    size={ring ? "size-5 text-xs" : "size-6 text-xs"}
                  />
                {/if}
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="bottom" align="start" sideOffset={6} class="min-w-44">
            <DropdownMenu.Label class="flex items-center gap-2">
              <PrAvatar name={reviewer.login} url={reviewer.avatarUrl ?? ""} size="size-4 text-xs" />
              <span class="min-w-0 truncate">{reviewer.login}</span>
              <span class="shrink-0 text-muted-foreground">· {verdict}</span>
            </DropdownMenu.Label>
            <DropdownMenu.Separator />
            <DropdownMenu.Item disabled={busy} onSelect={() => action.run(reviewer.login)}>
              {#if action.kind === "remove"}
                <XIcon size={13} class="shrink-0 text-muted-foreground" />
                Remove review request
              {:else}
                <RotateIcon size={13} class="shrink-0 text-muted-foreground" />
                Request review again
              {/if}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {:else}
        <span
          class="grid size-6 shrink-0 place-items-center rounded-full {ring
            ? 'outline-2 -outline-offset-0 outline-[var(--reviewer-ring)]'
            : ''}"
          style={ring ? `--reviewer-ring:${ring}` : undefined}
          title={`${reviewer.login} · ${verdict}`}
          role="img"
          aria-label={`${reviewer.login}, ${verdict}`}
        >
          <PrAvatar
            name={reviewer.login}
            url={reviewer.avatarUrl ?? ""}
            size={ring ? "size-5 text-xs" : "size-6 text-xs"}
          />
        </span>
      {/if}
    {/each}
    {#if onRequest}
      <button
        bind:this={addTrigger}
        type="button"
        class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] aria-expanded:bg-[var(--wash-2)] aria-expanded:text-foreground"
        aria-label="Request a reviewer"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Request a reviewer"
        onclick={() => handleMenuOpenChange(!menuOpen)}
      >
        {#if candidatesLoading && menuOpen}
          <CircleNotchIcon size={12} class="animate-spin [animation-duration:0.9s]" />
        {:else}
          <UserPlusIcon size={13} />
        {/if}
      </button>
      <ReviewerRequestMenu
        bind:open={menuOpen}
        anchor={addTrigger}
        {reviewers}
        {candidates}
        loading={candidatesLoading}
        loadFailed={candidatesLoadFailed}
        {mutation}
        onOpenChange={handleMenuOpenChange}
        {onRequest}
      />
    {:else if reviewers.length === 0}
      <span>No one requested yet</span>
    {/if}
  {/if}
</dd>
