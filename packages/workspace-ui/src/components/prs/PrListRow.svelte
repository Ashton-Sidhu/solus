<script lang="ts">
  import {
    CaretRightIcon,
    CheckSquareIcon,
    CircleNotchIcon,
    GitMergeIcon,
    GitPullRequestIcon,
    SquareIcon,
  } from "phosphor-svelte";
  import type { PullRequestSummary } from "@solus/contracts/providers";
  import type { PrChecksSummary } from "@solus/contracts/checks-types";
  import type { PrGuideMetadata, PrGuideStatus } from "@solus/contracts/review";
  import {
    formatAbsoluteTimestamp,
    formatTimeAgoFromTimestamp,
  } from "../../lib/sessionUtils";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { Button } from "../ui/button";
  import PrChecksChip from "./PrChecksChip.svelte";
  import ReviewGuideGlyph from "../review/ReviewGuideGlyph.svelte";
  import { checksPresentation } from "./lib/checks";
  import { relativeTime, reviewEffortTooltip } from "./lib/pr-utils";

  // One inbox row, in the design system's list-row form: a leading identity
  // tile, a 13.5px medium title, an 11.5px ` · `-joined meta line carrying the
  // head branch, and the trailing CI pill + caret. PrsPage stays the
  // state owner; selection and checks arrive as plain props/callbacks so this
  // remains a focused presentation unit.
  let {
    pr,
    stackParent = null,
    selected,
    checksSummary,
    checksLoadFailed = false,
    guideMetadata,
    guideStatus,
    selectable = false,
    reviewSelected = false,
    selectionActive = false,
    compact = false,
    onToggleReviewSelect,
    onSelect,
  }: {
    pr: PullRequestSummary;
    stackParent?: number | null;
    selected: boolean;
    checksSummary?: PrChecksSummary;
    checksLoadFailed?: boolean;
    guideMetadata?: PrGuideMetadata;
    guideStatus?: PrGuideStatus;
    /** Review multi-select: show the checkbox; `selectionActive` keeps every
     *  checkbox visible while any PR is checked. */
    selectable?: boolean;
    reviewSelected?: boolean;
    selectionActive?: boolean;
    /** Sidebar density: the row lives beside an open review, so it drops to the
     *  identity facts (title, number, time, CI dot) that still let you navigate. */
    compact?: boolean;
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
  const generatingGuide = $derived(
    guideStatus === "queued" || guideStatus === "generating",
  );
  // The compact row has no space for the checks badge, so CI collapses to a dot
  // carrying only the state — the full breakdown stays one click away in the
  // review pane's own chip.
  const checksDot = $derived(
    compact ? checksPresentation(checksSummary, pr.headSha, checksLoadFailed) : null,
  );
</script>

<!-- Plain open renders no icon: in an inbox of open PRs an identical green
     glyph per row is noise — only merged/closed states carry news (draft is
     already spelled out as text in the meta line). -->
{#snippet stateIcon()}
  {#if pr.state === "merged"}
    <GitMergeIcon size={12} class="text-xs shrink-0 text-(--review)" />
  {:else if pr.state === "closed"}
    <GitPullRequestIcon
      size={12}
      class="text-xs shrink-0 text-(--failure)"
    />
  {/if}
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="text-xs group relative mb-0.5 flex w-full cursor-pointer items-start text-left transition-colors {compact
    ? 'gap-2.5 rounded-lg px-2.5 py-2.5'
    : 'gap-3.5 rounded-lg px-4 py-3.5'} {selected
    ? 'bg-muted'
    : 'hover:bg-muted'}"
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
  <div
    class="group/lead relative mt-px shrink-0 {compact ? 'size-5' : 'size-7'}"
  >
    {#if pr.authorAvatarUrl}
      <img
        src={pr.authorAvatarUrl}
        alt=""
        loading="lazy"
        draggable="false"
        class="rounded-full transition-opacity duration-100 {compact
          ? 'size-5'
          : 'size-7'} {reviewSelected || selectionActive
          ? 'opacity-0'
          : 'group-hover:opacity-0 group-focus-within/lead:opacity-0'}"
      />
    {:else}
      <span
        class="grid place-items-center rounded-full bg-secondary font-medium text-secondary-foreground uppercase transition-opacity duration-100 {compact
          ? 'size-5 '
          : 'size-7 '} {reviewSelected || selectionActive
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
        class="absolute inset-0 inline-flex items-center justify-center rounded-md border-0 bg-transparent hover:bg-muted focus-visible:opacity-100 {compact
          ? 'size-5'
          : 'size-7'} {reviewSelected || selectionActive
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100'} {reviewSelected
          ? 'text-primary'
          : 'text-muted-foreground hover:text-foreground'}"
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
          <CheckSquareIcon size={compact ? 16 : 18} weight="fill" />
        {:else}
          <SquareIcon size={compact ? 16 : 18} />
        {/if}
      </Button>
    {/if}
  </div>

  {#if compact}
    <!-- Selection is carried by weight plus the muted fill, not a tint: the
         sidebar is a column of near-identical rows, and weight reads faster
         than colour at this size. -->
    <span class="flex min-w-0 flex-1 flex-col gap-1">
      <span
        class="truncate text-workspace-chrome {selected ? 'font-medium' : 'font-normal'}"
        >{pr.title}</span
      >
      <span
        class="flex min-w-0 items-center gap-1.5  whitespace-nowrap text-muted-foreground"
      >
        <span class="shrink-0 tabular-nums">#{pr.number}</span>
        <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
        <span class="truncate">{relativeTime(pr.updatedAt)}</span>
        {#if generatingGuide}
          <CircleNotchIcon
            size={10}
            class="shrink-0 animate-spin text-primary [animation-duration:0.9s] motion-reduce:animate-none"
            aria-label="Generating review guide"
          />
        {/if}
        {#if checksDot}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <span
                  {...tooltipProps}
                  class="size-1 shrink-0 rounded-full {checksDot.state ===
                  'passing'
                    ? 'bg-(--solus-art-positive)'
                    : checksDot.state === 'pending'
                      ? 'bg-chart-2'
                      : checksDot.state === 'failing' ||
                          checksDot.state === 'unavailable'
                        ? 'bg-(--solus-art-negative)'
                        : 'bg-border'}"
                  aria-label={checksDot.label}
                ></span>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content
              value={`${checksDot.label}: ${checksDot.tooltip}`}
            />
          </TooltipUI.Root>
        {/if}
      </span>
    </span>
  {:else}
    <span class="flex min-w-0 flex-1 flex-col gap-1.5">
      <span class="flex min-w-0 items-center gap-2">
        {@render stateIcon()}
        <span
          class="min-w-0 truncate text-workspace-chrome {selected
            ? 'font-medium'
            : 'font-medium'}">{pr.title}</span
        >
        {#if attentionLabel}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <span
                  {...tooltipProps}
                  class="shrink-0 rounded-full bg-secondary px-2 py-0.5  font-normal text-secondary-foreground"
                >
                  {attentionLabel}
                </span>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={attentionLabel === "Assigned"
              ? "You're assigned to this pull request"
              : "Your review was requested"} />
          </TooltipUI.Root>
        {/if}
      </span>
      <!-- One ` · `-joined line: identity first (number, author, time, churn),
           then the optional facts. Only the author and time flex, so the line
           stays a single row instead of reflowing into a stack of chips. -->
      <span
        class="flex min-w-0 items-center gap-2  whitespace-nowrap text-muted-foreground"
      >
        <span class="shrink-0 tabular-nums">#{pr.number}</span>
        {#if pr.author}
          <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
          <span class="min-w-0 truncate">{pr.author}</span>
        {/if}
        <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
        <span class="shrink-0">{relativeTime(pr.updatedAt)}</span>
        <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <span
                {...tooltipProps}
                class="flex shrink-0 items-center gap-1  tabular-nums"
              >
                <span class="text-(--solus-art-positive)">+{pr.additions}</span>
                <span class="text-(--solus-art-negative)">−{pr.deletions}</span>
              </span>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={`+${pr.additions} added · −${pr.deletions} removed`} />
        </TooltipUI.Root>
        {#if pr.headRef}
          <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
          <span
            class="min-w-0 truncate "
            title={pr.headRef}
          >
            {pr.headRef}
          </span>
        {/if}
        {#if pr.effort}
          <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <span {...tooltipProps} class="shrink-0 tabular-nums"
                  >~{pr.effort.minutes} min</span
                >
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={reviewEffortTooltip(pr) ?? ""} />
          </TooltipUI.Root>
        {/if}
        {#if stackParent !== null}
          <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
          <span class="shrink-0">stacked on #{stackParent}</span>
        {/if}
        {#if pr.draft}
          <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
          <span class="shrink-0">Draft</span>
        {/if}
        {#if generatingGuide}
          <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
          <span class="flex shrink-0 items-center gap-1 text-primary">
            <CircleNotchIcon
              size={10}
              class="shrink-0 animate-spin [animation-duration:0.9s] motion-reduce:animate-none"
            />
            {guideStatus === "queued" ? "Guide queued" : "Generating guide"}
          </span>
        {:else if guideMetadata}
          <span class="shrink-0 opacity-45" aria-hidden="true">·</span>
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <span
                  {...tooltipProps}
                  class="flex shrink-0 items-center gap-1 {guideMetadata.current
                    ? ''
                    : 'text-chart-2'}"
                >
                  <ReviewGuideGlyph size={10} class="shrink-0" />
                  Guide {guideTime}
                </span>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={guideTooltip} />
          </TooltipUI.Root>
        {/if}
      </span>
    </span>

    <!-- Trailing: CI as a status badge, then the caret that says this row opens
         into the review. -->
    <span class="mt-0.5 flex shrink-0 items-center gap-2.5">
      <PrChecksChip
        summary={checksSummary}
        headSha={pr.headSha}
        loadFailed={checksLoadFailed}
        pill
      />
      <CaretRightIcon
        size={13}
        class="shrink-0 text-muted-foreground opacity-45"
      />
    </span>
  {/if}
</div>
