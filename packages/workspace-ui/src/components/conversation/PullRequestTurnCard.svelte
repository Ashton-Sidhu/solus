<script lang="ts">
  import {
    Eye as EyeIcon,
    EyeOff as EyeOffIcon,
    GitPullRequest as GitPullRequestIcon,
    Lightbulb as LightbulbIcon,
  } from "@lucide/svelte";
  import { WATCH_OFFER, WATCHING_NOTE, type PullRequestCard } from "@solus/client-core/pull-request-card";
  import { prStatusBadge } from "../prs/lib/pr-utils";
  import TranscriptCard from "./TranscriptCard.svelte";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";
  import TranscriptCardRow from "./TranscriptCardRow.svelte";
  import { pullRequestCardMeta } from "./lib/pull-request-card";

  /**
   * A pull request the session linked during a turn: its state, its size, and
   * the session's watch on it (docs/plans/pr-watch.md). The card opens the
   * pull request; the footer turns the watch on or off. Grouped, it is one row
   * of a group card (`ReplyPullRequestGroup`), and the eye at its end is the
   * watch.
   */
  interface Props {
    card: PullRequestCard;
    /** A row of a group card, which draws the surface around all its rows. */
    grouped?: boolean;
    /** The viewer may change the session's watches. */
    canWatch: boolean;
    /** A watch request is in flight. */
    isWatchBusy: boolean;
    onOpen: () => void;
    onSetWatch: (watching: boolean) => void;
  }
  let { card, grouped = false, canWatch, isWatchBusy, onOpen, onSetWatch }: Props = $props();

  const badge = $derived(
    card.state === "open" || card.state === "draft" || card.state === "merged" || card.state === "closed"
      ? prStatusBadge({ state: card.state === "draft" ? "open" : card.state, draft: card.state === "draft" })
      : null,
  );
  const Icon = $derived(badge?.Icon ?? GitPullRequestIcon);
  const meta = $derived(pullRequestCardMeta(card));
  const isWatching = $derived(card.watch === "watching");
  // A viewer who may not change the watch still sees one that runs.
  const showsWatch = $derived(isWatching || (card.watch === "available" && canWatch));
  const ariaLabel = $derived(`Open pull request ${card.reference}: ${card.title}`);
  const watchLabel = $derived(
    isWatching
      ? `Stop watching ${card.reference}. ${WATCHING_NOTE}`
      : `Watch ${card.reference}. ${WATCH_OFFER}`,
  );
</script>

{#snippet size()}
  {#if card.additionsLabel && card.deletionsLabel}
    <span class="inline-flex gap-1">
      <span class="text-(--success)">{card.additionsLabel}</span>
      <span class="text-(--failure)">{card.deletionsLabel}</span>
    </span>
  {/if}
{/snippet}

{#if grouped}
  <TranscriptCardRow
    name={card.title}
    activity={card.stateLabel?.toLowerCase()}
    target={card.reference}
    {ariaLabel}
    {onOpen}
    data-testid="pull-request-group-row"
  >
    {#snippet glyph()}
      <span class="inline-flex" style:color={badge?.tone}><Icon aria-hidden="true" /></span>
    {/snippet}
    {#snippet rail()}
      {@render size()}
    {/snippet}
    {#snippet trailing()}
      <!-- Every row keeps the slot, so the sizes line up down the group. A
           merged or closed pull request has nothing to watch. -->
      {#if showsWatch && canWatch}
        <TranscriptCardAction
          kind="icon"
          label={watchLabel}
          disabled={isWatchBusy}
          data-testid="pull-request-group-row-watch"
          onclick={() => onSetWatch(!isWatching)}
        >
          {#if isWatching}
            <EyeIcon size={14} strokeWidth={1.75} class="text-(--success)" />
          {:else}
            <EyeOffIcon size={14} strokeWidth={1.75} />
          {/if}
        </TranscriptCardAction>
      {:else if isWatching}
        <span
          class="inline-flex size-6 shrink-0 items-center justify-center text-(--success)"
          role="img"
          aria-label={WATCHING_NOTE}
          title={WATCHING_NOTE}
        >
          <EyeIcon size={14} strokeWidth={1.75} />
        </span>
      {:else}
        <span class="size-6 shrink-0" aria-hidden="true"></span>
      {/if}
    {/snippet}
  </TranscriptCardRow>
{:else}
  <TranscriptCard
    title={card.title}
    type={card.stateLabel?.toLowerCase() ?? "pull request"}
    {ariaLabel}
    {onOpen}
    bodyLayout="prose"
    skipMotion
    data-testid="pull-request-turn-card"
  >
    {#snippet glyph()}
      <span class="inline-flex" style:color={badge?.tone}><Icon aria-hidden="true" /></span>
    {/snippet}
    {#snippet rail()}
      {#if card.filesLabel}<span>{card.filesLabel}</span>{/if}
      {@render size()}
    {/snippet}
    {#snippet body()}
      <p class="m-0 truncate text-transcript-meta text-muted-foreground">{meta}</p>
      {#if showsWatch}
        <div
          class="mt-2.5 flex min-w-0 items-center gap-2 border-t-[0.03125rem] border-(--solus-tx-divider) pt-2.5"
          data-testid="pull-request-turn-card-watch"
        >
          {#if isWatching}
            <EyeIcon size={14} strokeWidth={1.75} aria-hidden="true" class="shrink-0 text-(--success)" />
          {:else}
            <LightbulbIcon size={14} strokeWidth={1.75} aria-hidden="true" class="shrink-0 text-muted-foreground" />
          {/if}
          <span class="min-w-0 flex-1 text-transcript-meta text-muted-foreground">
            {isWatching ? WATCHING_NOTE : WATCH_OFFER}
          </span>
          {#if canWatch}
            <TranscriptCardAction
              kind={isWatching ? "ghost" : "primary"}
              disabled={isWatchBusy}
              label={isWatching ? "Stop watching this pull request" : "Watch this pull request"}
              data-testid="pull-request-turn-card-watch-toggle"
              onclick={() => onSetWatch(!isWatching)}
            >
              {isWatching ? "Turn off" : "Turn on"}
            </TranscriptCardAction>
          {/if}
        </div>
      {/if}
    {/snippet}
  </TranscriptCard>
{/if}
