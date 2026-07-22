<script lang="ts">
  import {
    BookOpenTextIcon,
    CheckSquareIcon,
    GitMergeIcon,
    GitPullRequestIcon,
    SquareIcon,
  } from "phosphor-svelte";
  import type { PullRequestSummary } from "../../../shared/providers";
  import type { PrChecksSummary } from "../../../shared/checks-types";
  import type { PrGuideMetadata } from "../../../shared/review";
  import {
    formatAbsoluteTimestamp,
    formatTimeAgoFromTimestamp,
  } from "../../lib/sessionUtils";
  import { tooltip } from "../../lib/tooltip";
  import { Button } from "../ui/button";
  import PrChecksChip from "./PrChecksChip.svelte";
  import { relativeTime, reviewEffortTooltip } from "./lib/pr-utils";

  // One inbox row. PrsPage stays the state owner; selection and checks arrive
  // as plain props/callbacks so this remains a focused presentation unit.
  let {
    pr,
    stackParent = null,
    selected,
    checksSummary,
    checksLoadFailed = false,
    guideMetadata,
    selectable = false,
    reviewSelected = false,
    selectionActive = false,
    onToggleReviewSelect,
    onSelect,
  }: {
    pr: PullRequestSummary;
    stackParent?: number | null;
    selected: boolean;
    checksSummary?: PrChecksSummary;
    checksLoadFailed?: boolean;
    guideMetadata?: PrGuideMetadata;
    /** Review multi-select: show the checkbox; `selectionActive` keeps every
     *  checkbox visible while any PR is checked. */
    selectable?: boolean;
    reviewSelected?: boolean;
    selectionActive?: boolean;
    onToggleReviewSelect?: () => void;
    onSelect: () => void;
  } = $props();

  const attentionLabel = $derived(
    pr.reviewAttention === "assigned"
      ? "Assigned"
      : pr.needsMyReview
        ? "Needs you"
        : null,
  );
  const guideTimestamp = $derived(
    guideMetadata?.generatedAt
      ? new Date(guideMetadata.generatedAt).getTime()
      : 0,
  );
  const guideTime = $derived(
    formatTimeAgoFromTimestamp(guideTimestamp) ?? "available",
  );
  const guideTooltip = $derived.by(() => {
    if (!guideMetadata) return "";
    const generated = formatAbsoluteTimestamp(guideTimestamp);
    return `${guideMetadata.current ? "Current" : "Outdated"} review guide${generated ? ` · generated ${generated}` : ""}`;
  });
</script>

<!-- Plain open renders no icon: in an inbox of open PRs an identical green
     glyph per row is noise — only merged/closed states carry news (draft is
     already spelled out as text in the meta line). -->
{#snippet stateIcon()}
  {#if pr.state === "merged"}
    <GitMergeIcon
      size={14}
      weight="bold"
      class="shrink-0 text-(--solus-accent)"
    />
  {:else if pr.state === "closed"}
    <GitPullRequestIcon
      size={14}
      weight="bold"
      class="shrink-0 text-(--solus-art-negative)"
    />
  {/if}
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="group relative flex cursor-pointer items-start gap-2.5 rounded-[0.625rem] px-3 py-2.5 transition-colors duration-150 {selected
    ? 'bg-[color-mix(in_srgb,var(--solus-accent)_8%,transparent)]'
    : 'hover:bg-(--solus-surface-hover)'}"
  role="button"
  tabindex="0"
  data-selected={selected || undefined}
  onclick={onSelect}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  }}
>
  <!-- Leading identity cell: the author's avatar, swapping in place to the
       review checkbox on row hover (and staying a checkbox while any PR is
       checked) — one fixed-size column, no layout shift either way. -->
  <div class="group/lead relative mt-0.5 size-5 shrink-0">
    {#if pr.authorAvatarUrl}
      <img
        src={pr.authorAvatarUrl}
        alt=""
        loading="lazy"
        draggable="false"
        class="size-5 rounded-full transition-opacity duration-100 {reviewSelected ||
        selectionActive
          ? 'opacity-0'
          : 'group-hover:opacity-0 group-focus-within/lead:opacity-0'}"
      />
    {:else}
      <span
        class="grid size-5 place-items-center rounded-full bg-(--solus-art-raised) text-[0.5625rem] font-semibold text-(--solus-text-tertiary) uppercase transition-opacity duration-100 {reviewSelected ||
        selectionActive
          ? 'opacity-0'
          : 'group-hover:opacity-0 group-focus-within/lead:opacity-0'}"
        aria-hidden="true"
      >
        {pr.author.slice(0, 1)}
      </span>
    {/if}
    {#if selectable}
      <Button
        type="button"
        class="absolute inset-0 inline-flex size-5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent hover:bg-(--solus-surface-hover) focus-visible:opacity-100 focus-visible:outline-none {reviewSelected ||
        selectionActive
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100'} {reviewSelected
          ? 'text-(--solus-accent)'
          : 'text-(--solus-text-tertiary) hover:text-(--solus-text-primary)'}"
        aria-label={reviewSelected
          ? "Remove from review selection"
          : "Select for review"}
        aria-pressed={reviewSelected}
        onclick={(e) => {
          e.stopPropagation();
          onToggleReviewSelect?.();
        }}
        title="Select for review (X)"
      >
        {#if reviewSelected}
          <CheckSquareIcon size={18} weight="fill" />
        {:else}
          <SquareIcon size={18} />
        {/if}
      </Button>
    {/if}
  </div>
  <div class="min-w-0 flex-1">
    <div class="flex items-start justify-between gap-3">
      <p
        class="min-w-0 flex-1 text-[0.875rem] leading-[1.3] font-medium tracking-[-0.011em] text-(--solus-text-primary) line-clamp-2"
      >
        {pr.title}
      </p>
      <div class="flex shrink-0 items-center gap-1.5">
        {#if pr.effort}
          <!-- Review effort right-aligns as its own scannable column. -->
          <span
            class="shrink-0 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)"
            use:tooltip={reviewEffortTooltip(pr) ?? ""}
          >
            ~{pr.effort.minutes} min
          </span>
        {/if}
      </div>
    </div>
    <div
      class="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-(--solus-text-tertiary)"
    >
      {@render stateIcon()}
      <span class="tabular-nums">#{pr.number}</span>
      {#if pr.author}
        <span aria-hidden="true">·</span>
        <span class="max-w-36 truncate">{pr.author}</span>
      {/if}
      <span aria-hidden="true">·</span>
      <span class="shrink-0 tabular-nums">{relativeTime(pr.updatedAt)}</span>
      <span aria-hidden="true">·</span>
      <span
        class="shrink-0 tabular-nums"
        use:tooltip={`+${pr.additions} added · −${pr.deletions} removed`}
      >
        <span class="text-(--solus-art-positive)">+{pr.additions}</span>
        <span class="text-(--solus-art-negative)">−{pr.deletions}</span>
      </span>
      {#if stackParent !== null}
        <span aria-hidden="true">·</span>
        <span
          class="shrink-0 font-medium text-(--solus-text-secondary) tabular-nums"
        >
          stacked on #{stackParent}
        </span>
      {/if}
      {#if pr.draft}
        <span aria-hidden="true">·</span>
        <span class="shrink-0 font-medium">Draft</span>
      {/if}
      {#if attentionLabel}
        <span
          class="inline-flex shrink-0 items-center rounded-full bg-(--solus-accent-light) px-1.5 py-px text-[0.625rem] font-semibold text-(--solus-accent)"
          use:tooltip={attentionLabel === "Assigned"
            ? "You're assigned to this pull request"
            : "Your review was requested"}
        >
          {attentionLabel}
        </span>
      {/if}
      <PrChecksChip
        summary={checksSummary}
        headSha={pr.headSha}
        loadFailed={checksLoadFailed}
        quietWhenPassing
      />
      {#if guideMetadata}
        <span
          class="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums {guideMetadata.current
            ? 'text-(--solus-text-secondary)'
            : 'text-amber-700 dark:text-amber-400'}"
          use:tooltip={guideTooltip}
        >
          <BookOpenTextIcon size={11} weight="bold" />
          Guide {guideTime}
        </span>
      {/if}
    </div>
  </div>
</div>
