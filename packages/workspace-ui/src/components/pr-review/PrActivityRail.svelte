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
    MessageCircle as MessageCircleIcon,
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
  import { checkDuration, orderedChecks } from "../prs/lib/checks";
  import { checkVerdict, checksSummary } from "./lib/check-verdict";
  import {
    reviewerRowAction,
    reviewerStateColor,
    reviewerStateLabel,
  } from "./lib/reviewer-state";
  import type { PrActionsLayout } from "./lib/pr-actions-layout";
  import { fileName, dirName } from "./lib/activity-data";
  import {
    mergeReadiness,
    readinessTone,
    type MergeAction,
  } from "./lib/merge-readiness";
  import {
    CHECKS_VISIBLE_ROWS,
    FILES_VISIBLE_ROWS,
    fileRowHeight,
    listViewportHeight,
  } from "./lib/rail-rows";
  import { Skeleton } from "../ui/skeleton";
  import ReviewerRequestMenu from "./ReviewerRequestMenu.svelte";

  // The changed-file rows carry brand glyphs, the same ones Files, Diff and the
  // pickers use. Registering the curated offline subset is idempotent and
  // lazy — unknown names still resolve through Iconify's API fallback.
  ensureIconCollections();

  // The activity tab's reference rail. The status leads it: what state
  // the pull request is in and the move that changes it; the review guide is
  // in its ⋯ menu. Under it sit reviewers, checks, and the changed files as
  // collapsible sections.
  //
  // The rail has two homes. Beside the conversation it is a pinned column.
  // Once the reading column is too narrow to keep one, the same rail is drawn
  // inline under the title instead: the status becomes a row and the sections
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
    checksLoadFailed = false,
    fixingCheckId = null,
    onFixCheck,
    unresolvedCount,
    onFileJump,
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
    /** The checks could not be read; the card must not call the PR ready. */
    checksLoadFailed?: boolean;
    fixingCheckId?: string | null;
    onFixCheck?: (check: CheckItem) => void;
    unresolvedCount: number;
    onFileJump?: (path: string) => void;
    /** Re-reads everything the rail shows. Offered beside any section that
     *  failed to load. */
    onRetry?: () => void;
    /** The PR's action cluster (the readiness move + quiet secondary row) — it
     *  lives with the readiness status it acts on, Linear-style, not in the
     *  header. It is handed the move the shared readiness model chose. */
    actions?: Snippet<[PrActionsLayout, MergeAction | null]>;
    /** The ⋯ menu of rarely-used PR actions. It rides beside the status,
     *  where it is always present, rather than under a cluster that a draft
     *  or a closed PR leaves empty. It is handed the same move as `actions`,
     *  so it offers what the card does not. */
    menu?: Snippet<[MergeAction | null]>;
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
  // Checks start folded on both homes: the section head carries a one-line
  // summary ("1 of 5 failing"), which is the answer most readings need.
  let sectionOpen = $state({
    reviewers: startsOpen,
    checks: false,
    files: startsOpen,
  });
  type SectionKey = keyof typeof sectionOpen;

  // Failing checks lead, so the rows above "Show more" always show what's
  // broken rather than whichever the host happened to list first.
  const allChecks = $derived(orderedChecks(checks));
  const checksHeadline = $derived(checksSummary(allChecks));
  let showAllChecks = $state(false);
  const visibleChecks = $derived(
    showAllChecks ? allChecks : allChecks.slice(0, CHECKS_VISIBLE_ROWS),
  );
  const hiddenCheckCount = $derived(allChecks.length - visibleChecks.length);
  const approvedReviewers = $derived(
    reviewers.reduce(
      (count, reviewer) => count + (reviewer.state === "APPROVED" ? 1 : 0),
      0,
    ),
  );
  const reviewersEmpty = $derived(
    !reviewersLoading && !reviewersLoadFailed && reviewers.length === 0,
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

  // Headline, sub-line, the blocked question, and the move all come from one
  // table so they cannot drift apart (see lib/merge-readiness).
  const readiness = $derived(
    detail
      ? mergeReadiness({
          detail,
          checks,
          checksLoadFailed,
          unresolvedCount,
          approvedReviewCount: approvedReviewers,
          openedTime,
        })
      : null,
  );
  const tone = $derived(readiness ? readinessTone(readiness.key) : "neutral");
  // The file list is virtualized, so it needs a row height and a scrollport
  // height in pixels. The heights follow the *display*, not the pane, because
  // the rail's own width does (ADR-0010) — a container query here would resize
  // rows on every drag frame of the pane divider.
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

<!-- Section head: the whole row is the fold control — label on the left,
     the section's one-line answer on the right, the chevron at the far edge —
     so a folded section still says what is in it. Sentence case at the chrome
     rung, not a letterspaced caps caption: the rail reads as quiet sections.

     A raw button, not the ghost primitive. `aria-expanded` on a disclosure
     means "this section is unfolded", and the ghost variant reads that
     attribute as a *menu trigger* and paints `aria-expanded:bg-muted`, so
     every open heading wore a permanent pressed chip. A section heading is a
     semantic-only control: no fill at rest, the hover wash only. -->
{#snippet sectionHead(label: string, key: SectionKey, trailing?: Snippet, foldable = true)}
  {#if foldable}
    <h3>
      <button
        type="button"
        aria-expanded={sectionOpen[key]}
        class="group/head -mx-2 mb-1 flex min-h-9 w-[calc(100%+1rem)] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-left transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none"
        onclick={() => (sectionOpen[key] = !sectionOpen[key])}
      >
        <span class="shrink-0 font-medium text-foreground">{label}</span>
        <CaretRightIcon
          size={12}
          class="shrink-0 text-muted-foreground opacity-50 transition-[transform,opacity] duration-200 ease-(--ease-premium) group-hover/head:opacity-90 motion-reduce:transition-none {sectionOpen[key]
            ? 'rotate-90'
            : ''}"
          aria-hidden="true"
        />
        <span class="ml-auto flex min-w-0 items-center justify-end text-xs">
          {#if trailing}{@render trailing()}{/if}
        </span>
      </button>
    </h3>
  {:else}
    <!-- Nothing to unfold: the same row, as a plain label and its answer. -->
    <h3 class="flex min-h-9 items-center gap-1.5">
      <span class="shrink-0 font-medium text-foreground">{label}</span>
      <span class="ml-auto flex min-w-0 items-center justify-end text-xs">
        {#if trailing}{@render trailing()}{/if}
      </span>
    </h3>
  {/if}
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
     coloured only when the colour says something the headline does not. A
     bare glyph beside the headline, not a filled disc: the card reports a
     state, it is not a call to action. -->
{#snippet readinessGlyph()}
  <span
    class="grid h-[1lh] shrink-0 place-items-center {tone === 'positive'
      ? 'text-(--solus-art-positive)'
      : tone === 'negative'
        ? 'text-(--solus-art-negative)'
        : tone === 'review'
          ? 'text-[color-mix(in_oklch,var(--review)_70%,var(--foreground))]'
          : 'text-muted-foreground'}"
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

<!-- Fixed widths rather than a percentage clamp: the rail's contents are mono
     paths, verdict words, and a status block whose line breaks were chosen
     against one measure, and a rail that resizes with the pane re-breaks all
     of them on every drag frame. The laptop step is a display decision
     (ADR-0010), not a container one. Inline, it is the reading column's own
     width, and there is nothing to pin. -->
<aside
  class={inline
    ? "w-full text-workspace-chrome"
    : "w-[330px] shrink-0 pb-6 text-workspace-chrome [.is-laptop-display_&]:w-[292px]"}
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
    <!-- The status: what state the pull request is in and the move that
         changes it, set straight on the canvas with no card around it — it
         reports a state, it is not a call to action. A hairline under it
         closes it off from the reference sections below. -->
    <section class="shrink-0 border-b border-[var(--hairline)] pb-4">
      {#if !detail || !readiness}
        <div class="flex items-center gap-2.5">
          <Skeleton class="size-4 shrink-0 rounded-full bg-muted" />
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton class="h-3.5 w-32 rounded bg-muted" />
            <Skeleton class="h-3 w-20 rounded bg-muted" />
          </div>
        </div>
      {:else if inline}
        <!-- One line: state on the left, the move that changes it on the
             right. The actions may shrink; the text column may truncate. -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div class="flex min-w-0 flex-[1_1_14rem] items-start gap-2.5">
            {@render readinessGlyph()}
            {@render readinessText()}
          </div>
          <div class="flex min-w-0 items-center gap-2">
            {#if actions}{@render actions("row", readiness.action)}{/if}
            {#if menu}<span class="shrink-0">{@render menu(readiness.action)}</span>{/if}
          </div>
        </div>
      {:else}
        <div>
          <div class="flex items-start gap-2.5">
            {@render readinessGlyph()}
            {@render readinessText()}
            <!-- The ⋯ rides with the headline, where it is always present,
                 rather than under a cluster that a draft or a closed PR
                 empties. -->
            {#if menu}<span class="-mr-1 shrink-0">{@render menu(readiness.action)}</span>{/if}
          </div>
          {#if actions}{@render actions("card", readiness.action)}{/if}
        </div>
      {/if}
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
    <section class="mt-6">
      {#snippet reviewerCount()}
        <span class="tabular-nums text-muted-foreground">
          {approvedReviewers} of {reviewers.length} approved
        </span>
      {/snippet}
      <!-- No one requested and no way to request anyone: the head says so on
           its own line, with nothing under it to unfold. -->
      {#snippet noReviewers()}
        <span class="text-muted-foreground">None requested</span>
      {/snippet}
      {@render sectionHead(
        "Reviewers",
        "reviewers",
        reviewersLoading
          ? undefined
          : reviewersEmpty
            ? noReviewers
            : reviewerCount,
        !(reviewersEmpty && !onRequestReviewer),
      )}
      <!-- Folded with `hidden`, not unmounted: the rows carry hover and menu
           state, and a fold is a reading choice, not a reason to rebuild them. -->
      <div class="-mx-2" class:hidden={!sectionOpen.reviewers}>
      {#if reviewersLoading}
        <div class="flex h-8 items-center gap-2.5 px-2">
          <Skeleton class="size-5 shrink-0 rounded-full bg-muted" />
          <Skeleton class="h-3 w-24 rounded bg-muted" />
        </div>
      {:else if reviewersLoadFailed}
        {@render loadFailure("Couldn’t load reviewers.")}
      {:else if reviewers.length === 0 && !onRequestReviewer}
        <!-- The head already says "None requested". -->
      {:else}
        <ul class="flex flex-col" role="list">
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
                <!-- The verdict as an icon in its own colour; the word stays
                     on the title and in the accessibility tree. -->
                <span
                  class="col-start-1 row-start-1 grid size-6 place-items-center {action
                    ? 'pointer-fine:group-hover/reviewer:invisible pointer-fine:group-focus-within/reviewer:invisible'
                    : ''}"
                  style={`color:${reviewerStateColor(reviewer.state)}`}
                  title={reviewerStateLabel(reviewer.state)}
                >
                  {#if reviewer.state === "APPROVED"}
                    <CheckCircleIcon size={14} aria-hidden="true" />
                  {:else if reviewer.state === "CHANGES_REQUESTED"}
                    <CircleAlertIcon size={14} aria-hidden="true" />
                  {:else if reviewer.state === "COMMENTED"}
                    <MessageCircleIcon size={14} aria-hidden="true" />
                  {:else if reviewer.state === "DISMISSED"}
                    <MinusCircleIcon size={14} aria-hidden="true" />
                  {:else}
                    <ClockIcon size={14} aria-hidden="true" />
                  {/if}
                  <span class="sr-only">{reviewerStateLabel(reviewer.state)}</span>
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
                    ? "Request a reviewer"
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

    {#if allChecks.length > 0}
      <section class="mt-6">
        {#snippet checksCount()}
          <!-- The folded section's whole answer: the rows' own status glyph,
               then the words. -->
          <span class="flex items-center gap-1.5 tabular-nums text-muted-foreground">
            {#if checksHeadline.icon === "failed"}
              <XCircleIcon size={13} class="shrink-0 text-(--solus-art-negative)" aria-hidden="true" />
            {:else if checksHeadline.icon === "running"}
              <CircleNotchIcon
                size={12}
                class="shrink-0 animate-spin [animation-duration:0.9s] motion-reduce:animate-none"
                aria-hidden="true"
              />
            {:else}
              <CheckCircleIcon size={13} class="shrink-0 text-(--solus-art-positive)" aria-hidden="true" />
            {/if}
            {checksHeadline.text}
          </span>
        {/snippet}
        {@render sectionHead("Checks", "checks", checksCount)}

        <!-- Failing checks lead, then the first six rows; the rest wait
             behind "Show more" instead of a scrollport inside the rail's own
             scroll. Folded with `hidden`, not unmounted, so a fold keeps the
             "Show more" choice. -->
        <div
          class="-mx-2"
          class:hidden={!sectionOpen.checks}
          role="group"
          aria-label="Checks"
        >
          <ul class="flex flex-col" role="list">
            {#each visibleChecks as item (item.id)}
              {@const duration = checkDuration(item)}
              {@const verdict = checkVerdict(item)}
              <li
                class="group/check flex h-[30px] items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-[var(--wash-2)] pointer-fine:[.is-laptop-display_&]:h-7"
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
                    aria-label={`Draft a fix for failed check ${item.name} in a session composer`}
                    title={fixingCheckId === item.id
                      ? `Preparing a fix composer for ${item.name}`
                      : `Draft a fix for ${item.name} in a session composer`}
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
              </li>
            {/each}
          </ul>
          {#if allChecks.length > CHECKS_VISIBLE_ROWS}
            <Button
              type="button"
              variant="ghost"
              aria-expanded={showAllChecks}
              class="mt-0.5 h-7 w-full cursor-pointer justify-start rounded-lg border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground aria-expanded:bg-transparent"
              onclick={() => (showAllChecks = !showAllChecks)}
            >
              {showAllChecks ? "Show less" : `Show ${hiddenCheckCount} more`}
            </Button>
          {/if}
        </div>
      </section>
    {/if}

    <section class="mt-6">
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
