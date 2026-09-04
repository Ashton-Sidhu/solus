<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import {
    CircleAlert as CircleAlertIcon,
    CircleCheck as CheckCircleIcon,
    ChevronRight as CaretRightIcon,
    CircleMinus as MinusCircleIcon,
    CircleX as XCircleIcon,
    Clock as ClockIcon,
    File as FileIcon,
    GitMerge as GitMergeIcon,
    Hammer as HammerIcon,
    LoaderCircle as CircleNotchIcon,
    Pen as PencilSimpleIcon,
    RotateCw as RotateIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import Icon from "@iconify/svelte";
  import { untrack, type Snippet } from "svelte";
  import type { ChangedFileStat } from "@solus/contracts/types";
  import type { PrGuideStatus } from "@solus/contracts/review";
  import type { CheckItem, PrChecksSummary } from "@solus/contracts/checks-types";
  import type {
    PullRequest,
    PrReviewer,
    PrReviewerCandidate,
  } from "@solus/contracts/providers";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { runtime } from "../../contexts";
  import { ensureIconCollections } from "../diagram/iconify";
  import { Button } from "../ui/button";
  import VirtualList from "../ui/list-page/VirtualList.svelte";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import ReviewGuideGlyph from "../review/ReviewGuideGlyph.svelte";
  import { checkDuration, orderedChecks } from "../prs/lib/checks";
  import { checkVerdict } from "./lib/check-verdict";
  import {
    reviewerRowAction,
    reviewerStateColor,
    reviewerStateLabel,
  } from "./lib/reviewer-state";
  import type { PrActionsLayout } from "./lib/pr-actions-layout";
  import { fileName, dirName } from "./lib/activity-data";
  import { mergeReadiness, readinessTone } from "./lib/merge-readiness";
  import {
    CHECKS_VISIBLE_ROWS,
    FILES_VISIBLE_ROWS,
    checkRowHeight,
    fileRowHeight,
    listViewportHeight,
  } from "./lib/rail-rows";
  import { Skeleton } from "../ui/skeleton";
  import ReviewerRequestMenu from "./ReviewerRequestMenu.svelte";

  // The changed-file rows carry brand glyphs, the same ones Files, Diff and the
  // pickers use. Registering the curated offline subset is idempotent and
  // lazy — unknown names still resolve through Iconify's API fallback.
  ensureIconCollections();

  // The activity tab's reference rail. The status card leads it: what state
  // the pull request is in, the move that changes it, and the review guide as
  // the card's own footer row — one object, because "can this land" and "how
  // do I read it" are the two questions you bring to the same card. Under it
  // sit reviewers, checks, and the changed files as collapsible sections,
  // ruled apart and labelled.
  //
  // The rail has two homes. Beside the conversation it is a pinned column.
  // Once the reading column is too narrow to keep one, the same rail is drawn
  // inline under the title instead: the card becomes a row and the sections
  // start folded, so the pull request's state stays in the first screen
  // without pushing the description out of it.
  let {
    detail,
    reviewers,
    reviewersLoading,
    reviewersLoadFailed = false,
    reviewerCandidates = [],
    reviewerCandidatesLoading = false,
    reviewerCandidatesLoadFailed = false,
    reviewerMutation = null,
    onOpenReviewerMenu,
    onRequestReviewer,
    onRemoveReviewer,
    changedFiles,
    filesLoading,
    filesLoadFailed = false,
    openedTime,
    checks,
    fixingCheckId = null,
    onFixCheck,
    unresolvedCount,
    onFileJump,
    guideStatus,
    onGenerateGuide,
    onRetry,
    actions,
    menu,
    variant = "column",
  }: {
    detail: PullRequest | null;
    reviewers: PrReviewer[];
    reviewersLoading: boolean;
    reviewersLoadFailed?: boolean;
    reviewerCandidates?: PrReviewerCandidate[];
    reviewerCandidatesLoading?: boolean;
    reviewerCandidatesLoadFailed?: boolean;
    reviewerMutation?: string | null;
    onOpenReviewerMenu?: () => void;
    onRequestReviewer?: (login: string) => void;
    onRemoveReviewer?: (login: string) => void;
    changedFiles: ChangedFileStat[];
    filesLoading: boolean;
    filesLoadFailed?: boolean;
    openedTime: string | null;
    checks?: PrChecksSummary;
    fixingCheckId?: string | null;
    onFixCheck?: (check: CheckItem) => void;
    unresolvedCount: number;
    onFileJump?: (path: string) => void;
    /** Background guide-generation lifecycle for this PR (guides are opt-in).
     *  Undefined means no guide has ever been asked for. */
    guideStatus?: PrGuideStatus;
    /** Absent while the PR cannot carry a guide (draft, closed, merged), which
     *  is what hides the row rather than showing a dead action. */
    onGenerateGuide?: () => void;
    /** Re-reads everything the rail shows. Offered beside any section that
     *  failed to load. */
    onRetry?: () => void;
    /** The PR's action cluster (merge CTA + quiet secondary row) — it lives
     *  with the readiness status it acts on, Linear-style, not in the header. */
    actions?: Snippet<[PrActionsLayout]>;
    /** The ⋯ menu of rarely-used PR actions. It rides in the status card,
     *  where it is always present, rather than under a cluster that a draft
     *  or a closed PR leaves empty. */
    menu?: Snippet;
    /** A column beside the conversation, or a block inside it. */
    variant?: "column" | "inline";
  } = $props();

  const inline = $derived(variant === "inline");

  let reviewerMenuOpen = $state(false);
  let reviewerTrigger = $state<HTMLButtonElement | null>(null);
  // Which reference sections are unfolded. Open is the resting state of a
  // column with room to spare; inline, the sections start folded so the
  // description is still on the first screen. Folding is a reading choice for
  // this sitting, not a preference worth persisting. Read once on mount: a
  // rail that moves homes is a different instance, not the same one resized.
  const startsOpen = untrack(() => variant === "column");
  let sectionOpen = $state({
    reviewers: startsOpen,
    checks: startsOpen,
    files: startsOpen,
  });
  type SectionKey = keyof typeof sectionOpen;

  const generatingGuide = $derived(
    guideStatus === "queued" || guideStatus === "generating",
  );
  // Only the states that say something the trailing action does not. The action
  // beside this row already reads "Generate" whenever no guide exists, so a
  // "Not generated yet" sub-line under it was the same fact twice on one row.
  const guideNote = $derived(
    guideStatus === "ready"
      ? "Ready to read"
      : guideStatus === "queued"
        ? "Queued"
        : guideStatus === "generating"
          ? "Generating…"
          : guideStatus === "failed"
            ? "Generation failed"
            : "",
  );

  // Failing checks lead, so the rows above the fold always show what's broken
  // rather than whichever the host happened to list first.
  const allChecks = $derived(orderedChecks(checks));
  const approvedReviewers = $derived(
    reviewers.reduce(
      (count, reviewer) => count + (reviewer.state === "APPROVED" ? 1 : 0),
      0,
    ),
  );
  function handleReviewerMenuOpenChange(open: boolean): void {
    reviewerMenuOpen = open;
    if (open) onOpenReviewerMenu?.();
  }

  /** The row's one action, and the handler that carries it out — absent when
   *  the viewer may not touch review requests on this pull request. */
  function reviewerAction(reviewer: PrReviewer) {
    const action = reviewerRowAction(reviewer.state);
    const run = action.kind === "remove" ? onRemoveReviewer : onRequestReviewer;
    return run ? { ...action, run } : null;
  }

  // Headline, sub-line, and the blocked question all come from one table so
  // they cannot drift apart (see lib/merge-readiness).
  const readiness = $derived(
    detail ? mergeReadiness({ detail, checks, unresolvedCount, openedTime }) : null,
  );
  const tone = $derived(readiness ? readinessTone(readiness.key) : "neutral");
  // Both lists are virtualized, so each needs a row height and a scrollport
  // height in pixels. The heights follow the *display*, not the pane, because
  // the rail's own width does (ADR-0010) — a container query here would resize
  // rows on every drag frame of the pane divider.
  const checkRowSize = $derived(checkRowHeight(runtime.isLaptopDisplay));
  const checksViewportHeight = $derived(
    listViewportHeight(
      allChecks.map(() => checkRowSize),
      CHECKS_VISIBLE_ROWS,
    ),
  );
  const fileRowSizes = $derived(
    changedFiles.map((file) => fileRowHeight(file, runtime.isLaptopDisplay)),
  );
  const fileRowSize = $derived((index: number) => fileRowSizes[index] ?? 0);
  const filesViewportHeight = $derived(
    listViewportHeight(fileRowSizes, FILES_VISIBLE_ROWS),
  );

  function openCheck(item: CheckItem) {
    if (!item.detailsUrl) return;
    void localApi.openExternal(item.detailsUrl);
    requestInputFocus();
  }
</script>

<!-- Section label: a letterspaced caption one step under the rows it heads,
     the fold control it names, and its own count on the right. The whole
     label is the target — a lone chevron is a 9px hit area on a control you
     use often. The rail reads at the chrome rung; captions and sub-lines take
     `text-xs`, and nothing here is smaller than that.

     A raw button, not the ghost primitive. `aria-expanded` on a disclosure
     means "this section is unfolded", and the ghost variant reads that
     attribute as a *menu trigger* and paints `aria-expanded:bg-muted`, so
     every open heading wore a permanent pressed chip. A section heading is a
     semantic-only control: no fill at rest, the hover wash only. -->
{#snippet sectionHead(label: string, key: SectionKey, trailing?: Snippet)}
  <div class="flex items-center gap-2 {sectionOpen[key] ? 'mb-1.5' : ''}">
    <h3 class="min-w-0">
      <button
        type="button"
        aria-expanded={sectionOpen[key]}
        class="-ml-1.5 flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
        onclick={() => (sectionOpen[key] = !sectionOpen[key])}
      >
        <CaretRightIcon
          size={10}
          class="shrink-0 opacity-60 transition-transform duration-150 {sectionOpen[
            key
          ]
            ? 'rotate-90'
            : ''}"
          aria-hidden="true"
        />
        {label}
      </button>
    </h3>
    {#if trailing}
      <span class="ml-auto shrink-0 text-xs">
        {@render trailing()}
      </span>
    {/if}
  </div>
{/snippet}

<!-- A section that could not be read says so where its rows would be, and
     offers the same retry the whole tab has — no banner over the page for one
     request that did not answer. -->
{#snippet loadFailure(message: string)}
  <p class="flex items-center gap-2 px-2 py-1 text-muted-foreground">
    <span class="min-w-0 flex-1">{message}</span>
    {#if onRetry}
      <button
        type="button"
        class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--wash-2)]"
        onclick={onRetry}
      >
        Retry
      </button>
    {/if}
  </p>
{/snippet}

<!-- The readiness glyph: the same host palette as the list's status dots, and
     coloured only when the colour says something the headline does not. -->
{#snippet readinessGlyph()}
  <span
    class="grid size-7 shrink-0 place-items-center rounded-full {tone === 'positive'
      ? 'bg-[color-mix(in_oklch,var(--solus-art-positive)_14%,transparent)] text-(--solus-art-positive)'
      : tone === 'negative'
        ? 'bg-[color-mix(in_oklch,var(--solus-art-negative)_14%,transparent)] text-(--solus-art-negative)'
        : tone === 'review'
          ? 'bg-[color-mix(in_oklch,var(--review)_14%,transparent)] text-[color-mix(in_oklch,var(--review)_70%,var(--foreground))]'
          : 'bg-[var(--wash-3)] text-muted-foreground'}"
    aria-hidden="true"
  >
    {#if readiness?.key === "ready"}
      <CheckCircleIcon size={15} />
    {:else if readiness?.key === "merged"}
      <GitMergeIcon size={14} />
    {:else if readiness?.key === "closed"}
      <XCircleIcon size={15} />
    {:else if readiness?.key === "draft"}
      <PencilSimpleIcon size={13} />
    {:else if readiness?.blocked}
      <CircleAlertIcon size={15} />
    {:else}
      <ClockIcon size={14} />
    {/if}
  </span>
{/snippet}

<!-- The card's text: the headline names the state, and the note under it
     names what stands in the way. Both truncate rather than re-flow the card;
     the full sentence stays on the title. -->
{#snippet readinessText()}
  <div class="flex min-w-0 flex-1 flex-col">
    <h3
      class="truncate font-medium text-foreground"
      title={readiness?.headline}
    >
      {readiness?.headline}
    </h3>
    {#if readiness?.note}
      <span
        class="truncate text-xs tabular-nums text-muted-foreground"
        title={readiness.note}
      >
        {readiness.note}
      </span>
    {/if}
  </div>
{/snippet}

<!-- Review guide: the card's footer row. It is one fact and one action, and
     it belongs with the state of the pull request rather than floating loose
     under the card as a second, unrelated object. -->
{#snippet guideRow()}
  {#if onGenerateGuide}
    <button
      type="button"
      disabled={generatingGuide}
      class="flex h-10 w-full cursor-pointer items-center gap-2.5 border-t border-[var(--hairline)] px-3.5 text-left transition-colors enabled:hover:bg-[var(--wash-2)] disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      title={guideStatus === "ready"
        ? "Open the review guide — regenerates only if the PR changed"
        : guideStatus === "failed"
          ? "Guide generation failed — try again"
          : "Generate the review guide in the background"}
      onclick={onGenerateGuide}
    >
      <ReviewGuideGlyph size={13} class="shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate">Review guide</span>
      {#if guideNote}
        <span class="shrink-0 truncate text-xs text-muted-foreground">
          {guideNote}
        </span>
      {/if}
      {#if generatingGuide}
        <CircleNotchIcon
          size={12}
          class="shrink-0 animate-spin text-muted-foreground [animation-duration:0.9s]"
        />
      {:else}
        <span class="shrink-0 text-xs font-medium text-primary">
          {guideStatus === "ready" ? "Regenerate" : "Generate"}
        </span>
      {/if}
    </button>
  {/if}
{/snippet}

<!-- Fixed widths rather than a percentage clamp: the rail's contents are mono
     paths, verdict words, and a status card whose line breaks were chosen
     against one measure, and a rail that resizes with the pane re-breaks all
     of them on every drag frame. The laptop step is a display decision
     (ADR-0010), not a container one. Inline, it is the reading column's own
     width, and there is nothing to pin. -->
<aside
  class={inline
    ? "w-full text-workspace-chrome"
    : "w-[330px] shrink-0 text-workspace-chrome [.is-laptop-display_&]:w-[292px]"}
>
  <!-- The cap is what makes `sticky` safe. Pinned flush, a rail taller than the
       scrollport never moves, so everything past the fold — the tail of an
       expanded checks list, and all of Changed files — becomes unreachable.
       Capping it gives the rail its own scroll instead. The negative inline
       gutter gives its scrollbox room for the rows' hover wash and focus
       rings, which are wider than the rail's text column. -->
  <div
    class={inline
      ? "flex flex-col"
      : "sticky top-[38px] -mx-[11px] flex flex-col px-[11px] [.is-laptop-display_&]:top-6 max-h-[calc(100vh-102px)] overflow-y-auto overscroll-contain"}
  >
    <!-- The status card: the rail's one bordered object, because it is the
         one thing you act on. Everything under it is reference material. -->
    <section
      class="overflow-hidden rounded-[14px] border border-[var(--hairline-strong)] bg-card"
    >
      {#if !detail || !readiness}
        <div class="flex items-center gap-3 p-3.5">
          <Skeleton class="size-7 shrink-0 rounded-full bg-muted" />
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton class="h-3.5 w-32 rounded bg-muted" />
            <Skeleton class="h-3 w-20 rounded bg-muted" />
          </div>
        </div>
      {:else if inline}
        <!-- One line: state on the left, the move that changes it on the
             right. The actions may shrink; the text column may truncate. -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-3 p-3.5">
          <div class="flex min-w-0 flex-[1_1_14rem] items-center gap-3">
            {@render readinessGlyph()}
            {@render readinessText()}
          </div>
          <div class="flex min-w-0 items-center gap-2">
            {#if actions}{@render actions("row")}{/if}
            {#if menu}<span class="shrink-0">{@render menu()}</span>{/if}
          </div>
        </div>
      {:else}
        <div class="p-3.5">
          <div class="flex items-center gap-3">
            {@render readinessGlyph()}
            {@render readinessText()}
            <!-- The ⋯ rides with the headline, where it is always present,
                 rather than under a cluster that a draft or a closed PR
                 empties. -->
            {#if menu}<span class="-mr-1 shrink-0">{@render menu()}</span>{/if}
          </div>
          {#if actions}{@render actions("card")}{/if}
        </div>
      {/if}
      {@render guideRow()}
    </section>

    <!-- Reviewers. One row per person: their avatar, login, and the verdict as
         a single lower-case word at the row's far edge. Hovering the row swaps
         that word for the one thing you can do to them — take a pending
         request back, or ask someone who has answered to look again. The two
         share one grid cell, so the verdicts stay in a single edge whether or
         not a row has an action.

         Only while the rail is a column. Inline, the reviewers are a row of
         the facts list under the title (PrReviewerFacts), so a folded section
         here would be the same people twice. -->
    {#if !inline}
    <section class="mt-5 border-t border-[var(--hairline)] pt-3.5">
      {#snippet reviewerCount()}
        <span class="tabular-nums text-muted-foreground">
          {approvedReviewers} of {reviewers.length} approved
        </span>
      {/snippet}
      {@render sectionHead(
        "Reviewers",
        "reviewers",
        reviewersLoading || reviewers.length === 0 ? undefined : reviewerCount,
      )}
      <!-- Folded with `hidden`, not unmounted: the rows carry hover and menu
           state, and a fold is a reading choice, not a reason to rebuild them. -->
      <div class:hidden={!sectionOpen.reviewers}>
      {#if reviewersLoading}
        <div class="-mx-2 flex h-8 items-center gap-2.5 px-2">
          <Skeleton class="size-5 shrink-0 rounded-full bg-muted" />
          <Skeleton class="h-3 w-24 rounded bg-muted" />
        </div>
      {:else if reviewersLoadFailed}
        <div class="-mx-2">{@render loadFailure("Couldn’t load reviewers.")}</div>
      {:else if reviewers.length === 0 && !onRequestReviewer}
        <p class="text-muted-foreground">No one requested yet</p>
      {:else}
        <ul class="-mx-2 flex flex-col" role="list">
          {#each reviewers as reviewer (reviewer.login)}
            {@const action = reviewerAction(reviewer)}
            {@const busy = reviewerMutation === reviewer.login}
            <li
              class="group/reviewer flex h-8 items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-[var(--wash-2)]"
            >
              <PrAvatar
                name={reviewer.login}
                url={reviewer.avatarUrl ?? ""}
                size="size-5 text-xs"
              />
              <span class="min-w-0 flex-1 truncate">
                {reviewer.login}
              </span>
              <span
                class="grid shrink-0 items-center justify-items-end pointer-coarse:gap-1.5"
              >
                <span
                  class="col-start-1 row-start-1 text-xs whitespace-nowrap {action
                    ? 'pointer-fine:group-hover/reviewer:invisible pointer-fine:group-focus-within/reviewer:invisible'
                    : ''}"
                  style={`color:${reviewerStateColor(reviewer.state)}`}
                >
                  {reviewerStateLabel(reviewer.state)}
                </span>
                {#if action}
                  <!-- Precise pointers reveal it in the verdict's own cell;
                       touch has no hover, so the control stays beside the
                       verdict as a glyph. -->
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    class="col-start-1 row-start-1 h-6 cursor-pointer gap-1 rounded-md bg-[var(--wash-3)] px-2 text-xs font-medium text-foreground opacity-0 transition-opacity hover:bg-[var(--wash-3)] focus-visible:opacity-100 pointer-fine:group-hover/reviewer:opacity-100 pointer-coarse:col-start-2 pointer-coarse:size-7 pointer-coarse:px-0 pointer-coarse:opacity-100"
                    aria-label={action.kind === "remove"
                      ? `Remove ${reviewer.login} as a requested reviewer`
                      : `Request another review from ${reviewer.login}`}
                    title={action.kind === "remove"
                      ? "Remove review request"
                      : "Re-request review"}
                    onclick={() => action.run(reviewer.login)}
                  >
                    {#if busy}
                      <CircleNotchIcon size={11} class="animate-spin" />
                    {:else if action.kind === "remove"}
                      <XIcon size={11} />
                    {:else}
                      <RotateIcon size={11} />
                    {/if}
                    <span class="pointer-coarse:sr-only">{action.label}</span>
                  </Button>
                {/if}
              </span>
            </li>
          {/each}
          <!-- Requesting is a row in the list it adds to, not an action word in
               the section head: on an empty section that row *is* the empty
               state, and on a full one it stays the same object in the same
               place instead of moving once someone is listed. -->
          {#if onRequestReviewer}
            <li>
              <Button
                bind:ref={reviewerTrigger}
                type="button"
                variant="ghost"
                class="flex h-8 w-full cursor-pointer items-center justify-start gap-2.5 rounded-lg px-2 py-0 font-normal transition-colors hover:bg-[var(--wash-2)]"
                aria-label="Request a reviewer"
                aria-haspopup="menu"
                aria-expanded={reviewerMenuOpen}
                onclick={() => handleReviewerMenuOpenChange(!reviewerMenuOpen)}
              >
                <span class="min-w-0 flex-1 truncate text-left text-muted-foreground">
                  {reviewers.length === 0
                    ? "No one requested yet"
                    : "Request another reviewer"}
                </span>
                {#if reviewerCandidatesLoading}
                  <CircleNotchIcon size={11} class="shrink-0 animate-spin text-muted-foreground" />
                {:else}
                  <span class="shrink-0 text-xs font-medium text-primary">Request</span>
                {/if}
              </Button>
            </li>
          {/if}
        </ul>
      {/if}
      </div>

      {#if onRequestReviewer}
        <ReviewerRequestMenu
          bind:open={reviewerMenuOpen}
          anchor={reviewerTrigger}
          {reviewers}
          candidates={reviewerCandidates}
          loading={reviewerCandidatesLoading}
          loadFailed={reviewerCandidatesLoadFailed}
          mutation={reviewerMutation}
          onOpenChange={handleReviewerMenuOpenChange}
          onRequest={onRequestReviewer}
        />
      {/if}
    </section>
    {/if}

    <!-- Checks -->
    {#if allChecks.length > 0}
      <section class="mt-5 border-t border-[var(--hairline)] pt-3.5">
        {#snippet checksCount()}
          <!-- A plain total mirrors the rows below without repeating their
               verdicts or adding another status colour to the heading. -->
          <span class="tabular-nums text-muted-foreground">
            {allChecks.length}
          </span>
        {/snippet}
        {@render sectionHead("Checks", "checks", checksCount)}

        <!-- Every check is in the list while the section is open — hiding the
             green ones behind a second toggle would make the passing state the
             only one you cannot inspect. Past six rows the section becomes its
             own scrollport rather than growing without bound.

             Folded with `hidden`, not unmounted: the list keeps its scroll
             offset, and the height it is given is computed rather than
             measured, so a hidden section still renders correctly when it comes
             back. -->
        <div
          class="-mx-2"
          class:hidden={!sectionOpen.checks}
          role="group"
          aria-label="Checks"
        >
          <VirtualList
            items={allChecks}
            height={checksViewportHeight}
            itemSize={checkRowSize}
            keyOf={(item) => item.id}
          >
            {#snippet children(item, _index, style)}
              {@const duration = checkDuration(item)}
              {@const verdict = checkVerdict(item)}
              <!-- The row takes its height from the list's own `style`, never
                   from a class of its own — see lib/rail-rows. -->
              <div
                {style}
                class="group/check flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-[var(--wash-2)]"
              >
                <button
                  type="button"
                  disabled={!item.detailsUrl}
                  class="flex h-full min-w-0 flex-1 items-center justify-start gap-2.5 overflow-hidden rounded-lg px-2 py-0 text-left font-normal enabled:cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
                  onclick={() => openCheck(item)}
                  title={item.detailsUrl ? `Open details for ${item.name}` : undefined}
                >
                  <span class="grid size-3.5 shrink-0 place-items-center" aria-hidden="true">
                    {#if verdict.icon === "passed"}
                      <CheckCircleIcon
                        size={13}
                        class="text-(--solus-art-positive)"
                      />
                    {:else if verdict.icon === "failed"}
                      <XCircleIcon
                        size={13}
                        class="text-(--solus-art-negative)"
                      />
                    {:else if verdict.icon === "running"}
                      <CircleNotchIcon
                        size={12}
                        class="animate-spin text-muted-foreground [animation-duration:0.9s]"
                      />
                    {:else}
                      <MinusCircleIcon size={12} class="text-muted-foreground" />
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1 truncate">
                    {item.name}
                  </span>
                  <span class="sr-only">{verdict.word}</span>
                  <!-- The duration column holds its width whether or not a row
                       has one, so the verdicts stay in a single edge. -->
                  <span
                    class="w-[48px] shrink-0 text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground"
                  >
                    {duration ?? ""}
                  </span>
                </button>
                {#if verdict.icon === "failed" && onFixCheck}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={fixingCheckId !== null}
                    class="h-6 shrink-0 cursor-pointer gap-1 rounded-md px-1.5 text-xs font-medium text-(--solus-art-negative) transition-[background-color,color,scale] hover:bg-[color:color-mix(in_srgb,var(--solus-art-negative)_10%,transparent)] hover:text-(--solus-art-negative) focus-visible:ring-[color:color-mix(in_srgb,var(--solus-art-negative)_24%,transparent)] active:scale-[0.96]"
                    aria-label={`Fix failed check ${item.name} in an agent session`}
                    title={fixingCheckId === item.id
                      ? `Preparing a fix session for ${item.name}`
                      : `Fix ${item.name} in an agent session`}
                    onclick={() => onFixCheck(item)}
                  >
                    {#if fixingCheckId === item.id}
                      <CircleNotchIcon
                        size={11}
                        class="size-[11px] animate-spin [animation-duration:0.9s]"
                      />
                    {:else}
                      <HammerIcon size={11} class="size-[11px]" />
                    {/if}
                    Fix
                  </Button>
                {/if}
              </div>
            {/snippet}
          </VirtualList>
        </div>
      </section>
    {/if}

    <!-- Changed files -->
    <section class="mt-5 border-t border-[var(--hairline)] pt-3.5">
      {#snippet fileCount()}
        {#if filesLoading}
          <Skeleton class="h-3 w-8 rounded bg-muted" />
        {:else}
          <span class="tabular-nums text-muted-foreground">
            {changedFiles.length}
            {changedFiles.length === 1 ? "file" : "files"}
          </span>
        {/if}
      {/snippet}
      {@render sectionHead("Changed files", "files", fileCount)}

      <!-- No churn summary here. The facts line under the title already
           carries this pull request's totals; the per-file counts below are
           the thing this section adds. -->
      <div class="-mx-2" class:hidden={!sectionOpen.files}>
        {#if filesLoading}
          <ul class="flex flex-col" role="list">
            {#each [0, 1, 2, 3] as i (i)}
              <!-- The skeleton reserves the glyph slot too, so the text column
                   does not jump left-to-right when the files land. -->
              <li class="flex items-center gap-2.5 px-2 py-[7px]">
                <Skeleton class="size-3.5 shrink-0 rounded bg-muted" />
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                  <Skeleton class="h-3 rounded bg-muted" style={`width:${70 - i * 12}%`} />
                  <Skeleton class="h-2.5 rounded bg-muted" style={`width:${50 - i * 8}%`} />
                </span>
              </li>
            {/each}
          </ul>
        {:else if filesLoadFailed}
          {@render loadFailure("Couldn’t load the changed files.")}
        {:else}
          <!-- Seven rows, then the section scrolls itself. A rename-heavy or
               generated change runs to hundreds of files, and the rail is
               pinned: without a cap the list either runs past the bottom of a
               `sticky` column or forces the whole rail to scroll for one
               section. -->
          <div role="group" aria-label="Changed files">
            <VirtualList
              items={changedFiles}
              height={filesViewportHeight}
              itemSize={fileRowSize}
              keyOf={(file) => file.path}
            >
              {#snippet children(file, _index, style)}
                {@const icon = fileTypeIcon(file.path)}
                <!-- Two lines of mono behind a file-type glyph: the filename
                     carries the churn on its own baseline, the directory sits
                     under it. Rail paths are long and a single line would
                     truncate the part that identifies the file.

                     The glyph is the same `fileTypeIcon` brand mark Files,
                     Diff, the file picker and project search all use. It
                     falls back to a neutral document mark for a type with no
                     logo, which is what keeps the text column in one edge.

                     The row height comes from the list's own `style`; a file at
                     the repository root has no directory line and gets the
                     short height (see lib/rail-rows). -->
                <div {style}>
                  <Button
                    type="button"
                    variant="ghost"
                    class="flex h-full w-full cursor-pointer items-center justify-start gap-2.5 rounded-lg px-2 py-0 text-left text-review-file font-normal transition-colors hover:bg-[var(--wash-2)]"
                    onclick={() => onFileJump?.(file.path)}
                  >
                    {#if icon}
                      <Icon {icon} width="14" height="14" class="shrink-0" />
                    {:else}
                      <FileIcon
                        size={14}
                        class="shrink-0 text-muted-foreground opacity-70"
                      />
                    {/if}
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="min-w-0 truncate font-mono"
                        >{fileName(file.path)}</span
                      >
                      {#if dirName(file.path)}
                        <span
                          class="min-w-0 truncate font-mono text-muted-foreground opacity-80"
                          >{dirName(file.path).replace(/\/$/, "")}</span
                        >
                      {/if}
                    </span>
                    <span
                      class="flex shrink-0 items-center gap-1 font-mono tabular-nums"
                    >
                      {#if file.additions}<span
                          class="text-(--solus-art-positive)">+{file.additions}</span
                        >{/if}
                      {#if file.deletions}<span
                          class="text-(--solus-art-negative)">−{file.deletions}</span
                        >{/if}
                    </span>
                  </Button>
                </div>
              {/snippet}
            </VirtualList>
          </div>
        {/if}
      </div>
    </section>
  </div>
</aside>
