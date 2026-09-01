<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import {
    CircleCheck as CheckCircleIcon,
    ChevronRight as CaretRightIcon,
    CircleMinus as MinusCircleIcon,
    Hammer as HammerIcon,
    LoaderCircle as CircleNotchIcon,
    File as FileIcon,
    CircleX as XCircleIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import Icon from "@iconify/svelte";
  import type { Snippet } from "svelte";
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
  import { checkDuration, orderedChecks } from "../prs/lib/checks";
  import { checkVerdict } from "./lib/check-verdict";
  import { reviewerStateColor, reviewerStateLabel } from "./lib/reviewer-state";
  import { fileName, dirName } from "./lib/activity-data";
  import { mergeReadiness } from "./lib/merge-readiness";
  import {
    CHECKS_VISIBLE_ROWS,
    FILES_VISIBLE_ROWS,
    checkRowHeight,
    fileRowHeight,
    listViewportHeight,
  } from "./lib/rail-rows";
  import { Skeleton } from "../ui/skeleton";
  import * as DropdownMenu from "../ui/dropdown-menu";

  // The changed-file rows carry brand glyphs, the same ones Files, Diff and the
  // pickers use. Registering the curated offline subset is idempotent and
  // lazy — unknown names still resolve through Iconify's API fallback.
  ensureIconCollections();

  // The activity tab's right rail. Merge readiness leads it as the column's one
  // card: it is the only section you act on, and giving it the rail's only
  // border makes "what do I do about this pull request" a distinct object from
  // the reference material under it. Review guide is a single row; reviewers,
  // checks, and the changed files are collapsible sections, ruled apart and
  // labelled, so a long checks list can be folded out of the way without
  // scrolling past it.
  let {
    detail,
    reviewers,
    reviewersLoading,
    reviewerCandidates = [],
    reviewerCandidatesLoading = false,
    reviewerMutation = null,
    onRequestReviewer,
    onRemoveReviewer,
    changedFiles,
    filesLoading,
    openedTime,
    checks,
    fixingCheckId = null,
    onFixCheck,
    unresolvedCount,
    onFileJump,
    guideStatus,
    onGenerateGuide,
    actions,
    menu,
    showReadiness = true,
  }: {
    detail: PullRequest | null;
    reviewers: PrReviewer[];
    reviewersLoading: boolean;
    reviewerCandidates?: PrReviewerCandidate[];
    reviewerCandidatesLoading?: boolean;
    reviewerMutation?: string | null;
    onRequestReviewer?: (login: string) => void;
    onRemoveReviewer?: (login: string) => void;
    changedFiles: ChangedFileStat[];
    filesLoading: boolean;
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
    /** The PR's action cluster (merge CTA + quiet secondary row) — it lives
     *  with the readiness status it acts on, Linear-style, not in the header. */
    actions?: Snippet;
    /** The ⋯ menu of rarely-used PR actions. It rides in this section's own
     *  header, where it is always present, rather than under a cluster that a
     *  draft or a closed PR leaves empty. */
    menu?: Snippet;
    /** False where `PrMergeBar` is carrying the readiness card instead — once
     *  this rail folds under the reading column, keeping the card here would
     *  put the one thing you act on past every comment on the pull request. The
     *  card moves to the bottom bar there, and this keeps the reference
     *  material it was sitting above. Both read one `mergeReadiness()`, so
     *  wherever it is drawn it says the same thing. */
    showReadiness?: boolean;
  } = $props();

  let reviewerMenuOpen = $state(false);
  let reviewerTrigger = $state<HTMLButtonElement | null>(null);
  // Which reference sections are unfolded. Open is the resting state — folding
  // is a reading choice for this sitting, not a preference worth persisting.
  let sectionOpen = $state({ reviewers: true, checks: true, files: true });
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
  const availableReviewerCandidates = $derived(
    reviewerCandidates.filter(
      (candidate) =>
        !reviewers.some(
          (reviewer) => reviewer.login.toLowerCase() === candidate.login.toLowerCase(),
        ),
    ),
  );
  // Headline, sub-line, and the blocked question all come from one table so
  // they cannot drift apart (see lib/merge-readiness).
  const readiness = $derived(
    detail ? mergeReadiness({ detail, checks, unresolvedCount, openedTime }) : null,
  );
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

<!-- Section label: the design system's letterspaced micro-caption, the fold
     control it names, and its own count on the right. The whole label is the
     target — a lone chevron is a 9px hit area on a control you use often.
     The rail carries the same two rungs as the meta band under the title, and
     no others: `text-micro` for a caption, `text-review-row` for
     everything a caption names. A third size in between meant the rail and the
     band described the same kinds of fact at different sizes a screen apart.
     The label rung is what keeps a heading from matching the rows it heads.

     A raw button, not the ghost primitive. `aria-expanded` on a disclosure
     means "this section is unfolded", and open is the resting state — but the
     ghost variant reads that attribute as a *menu trigger* and paints
     `aria-expanded:bg-muted`, so all three headings wore a permanent pressed
     chip that the spec does not have. The variant also carries a
     `dark:hover:bg-muted/50` twin that would beat the wash below in dark mode,
     and a press-nudge meant for buttons. A section heading is a semantic-only
     control: no fill at rest, the hover wash only. -->
{#snippet sectionHead(label: string, key: SectionKey, trailing?: Snippet)}
  <div class="mb-2 flex items-center gap-2">
    <h3>
      <button
        type="button"
        aria-expanded={sectionOpen[key]}
        class="-ml-1 flex cursor-pointer items-center gap-[7px] rounded-md px-1 py-0.5 text-micro font-medium tracking-[0.12em] text-muted-foreground uppercase transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
        onclick={() => (sectionOpen[key] = !sectionOpen[key])}
      >
        <CaretRightIcon
          size={9}
          class="shrink-0 opacity-50 transition-transform duration-150 {sectionOpen[
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
      <span class="ml-auto shrink-0 font-medium">
        {@render trailing()}
      </span>
    {/if}
  </div>
{/snippet}

<!-- The rail is never lost: below the review's ~1000px it folds under the main
     column at full width instead of hiding.

     Fixed widths rather than a percentage clamp: the rail's contents are
     mono paths, verdict words, and a merge card whose line breaks were chosen
     against one measure, and a rail that resizes with the pane re-breaks all of
     them on every drag frame. The laptop step is a display decision (ADR-0010),
     not a container one. -->
<aside
  class="w-[330px] shrink-0 text-review-row [.is-laptop-display_&]:w-[292px] @max-[1000px]:w-full"
>
  <!-- The cap is what makes `sticky` safe. Pinned flush, a rail taller than the
       scrollport never moves, so everything past the fold — the tail of an
       expanded checks list, and all of Changed files — becomes unreachable.
       Capping it gives the rail its own scroll instead. Only while it *is* a
       rail: below 1000px it folds under the main column at full width, where a
       second scrollbox would be wrong.

       The pinned rail keeps the shell's own top gutter rather than riding the
       scrollport edge, and the negative inline gutter gives its scrollbox room
       for the rows' hover wash and focus rings, which are wider than the rail's
       text column. -->
  <div
    class="sticky top-[38px] -mx-[11px] flex flex-col px-[11px] [.is-laptop-display_&]:top-6 @min-[1001px]:max-h-[calc(100vh-102px)] @min-[1001px]:overflow-y-auto @min-[1001px]:overscroll-contain"
  >
    <!-- Merge readiness: the rail's one card. Everything below it is reference
         material you read; this is the thing you act on, and the border is what
         says so.

         The card used to open with a letterspaced eyebrow — READY, Blocked,
         Checks failing — above a headline that said the same thing in a
         sentence: "READY" over "Ready to merge", and for a closed PR the
         identical word twice. The headline is the better of the two, because it
         names the base branch a conflict is with, so the eyebrow is gone and
         the sentence leads the card. That takes a whole row of chrome and the
         rail's tinted micro-label out at once. -->
    {#if showReadiness}
    <section
      class="overflow-hidden rounded-[14px] border border-[var(--hairline-strong)] bg-card"
    >
      <div class="p-[13px] [.is-laptop-display_&]:p-3">
        <div class="flex min-w-0 flex-col gap-1">
          {#if !detail || !readiness}
            <Skeleton class="h-[18px] w-32 rounded bg-muted" />
            <Skeleton class="mt-0.5 h-3 w-20 rounded bg-muted" />
          {:else}
            <div class="flex min-w-0 items-start gap-2">
              <!-- One line: a long base-branch name truncates rather than
                   re-flowing the card, and the full sentence stays on the
                   title. -->
              <h3
                class="min-w-0 flex-1 truncate text-[14.5px] leading-[1.25] font-semibold tracking-[-0.014em] [.is-laptop-display_&]:text-[13px]"
                title={readiness.headline}
              >
                {readiness.headline}
              </h3>
              <!-- The ⋯ rides with the headline, where it is always present,
                   rather than under a cluster that a draft or a closed PR
                   empties. It had a header row of its own until that row's only
                   other content turned out to be a restatement. -->
              {#if menu}<span class="-mt-1 -mr-1 shrink-0">{@render menu()}</span>{/if}
            </div>
            {#if readiness.note}
              <span
                class="truncate tabular-nums text-muted-foreground"
                title={readiness.note}
              >
                {readiness.note}
              </span>
            {/if}
          {/if}
        </div>

        {#if actions}{@render actions()}{/if}
      </div>
    </section>
    {/if}

    <!-- Review guide: one row, because it is one fact and one action. It sits
         outside the merge card — a guide is something to read, not a step in
         landing the change — and above the reference sections, which is the
         order you meet them in. -->
    {#if onGenerateGuide}
      <Button
        type="button"
        variant="ghost"
        disabled={generatingGuide}
        class="mt-4 -mx-[11px] flex h-10 cursor-pointer items-center justify-start gap-2.5 overflow-hidden rounded-[10px] px-[11px] py-0 text-left font-normal transition-colors enabled:hover:bg-[var(--wash-2)]"
        title={guideStatus === "ready"
          ? "Open the review guide — regenerates only if the PR changed"
          : guideStatus === "failed"
            ? "Guide generation failed — try again"
            : "Generate the review guide in the background"}
        onclick={onGenerateGuide}
      >
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="truncate font-medium tracking-[-0.005em]"
            >Review guide</span
          >
          <span class="truncate text-muted-foreground"
            >{guideNote}</span
          >
        </span>
        {#if generatingGuide}
          <CircleNotchIcon
            size={12}
            class="shrink-0 animate-spin text-muted-foreground [animation-duration:0.9s]"
          />
        {:else}
          <span class="shrink-0 font-medium text-foreground">
            {guideStatus === "ready" ? "Regenerate" : "Generate"}
          </span>
        {/if}
      </Button>
    {/if}

    <!-- Reviewers. One 30px row per person: avatar, login, and the verdict as a
         single lower-case word in its own colour. The section's action is a word
         ("Request"), not a glyph — it is the only thing you can do here, and the
         rail has no other icon buttons to read it against. -->
    <section class="mt-5 border-t border-[var(--hairline)] pt-3.5">
      <!-- The count is an aggregate, so it only earns its place once there is
           something to aggregate. With nobody requested it read "none yet"
           above a row already saying "No one requested yet" beside a button
           already saying "Request" — three ways of saying the same nothing. -->
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
        <div class="-mx-[9px] flex h-[30px] items-center gap-[9px] px-[9px]">
          <Skeleton class="size-5 shrink-0 rounded-full bg-muted" />
          <Skeleton class="h-3 w-24 rounded bg-muted" />
        </div>
      {:else if reviewers.length === 0 && !onRequestReviewer}
        <p class="px-[9px] text-muted-foreground">
          No one requested yet
        </p>
      {:else}
        <ul class="-mx-[9px] flex flex-col" role="list">
          {#each reviewers as reviewer (reviewer.login)}
            <li
              class="group/reviewer flex h-[30px] items-center gap-[9px] rounded-[9px] px-[9px] transition-colors hover:bg-[var(--wash-2)]"
            >
              <PrAvatar name={reviewer.login} size="size-5" />
              <span class="min-w-0 flex-1 truncate">
                {reviewer.login}
              </span>
              <span
                class="shrink-0 whitespace-nowrap"
                style={`color:${reviewerStateColor(reviewer.state)}`}
              >
                {reviewerStateLabel(reviewer.state)}
              </span>
              {#if reviewer.state === null && onRemoveReviewer}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={reviewerMutation === reviewer.login}
                  class="size-4 shrink-0 cursor-pointer text-muted-foreground opacity-0 transition-opacity group-hover/reviewer:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-foreground"
                  aria-label={`Remove ${reviewer.login} as a requested reviewer`}
                  onclick={() => onRemoveReviewer?.(reviewer.login)}
                >
                  {#if reviewerMutation === reviewer.login}
                    <CircleNotchIcon size={11} class="animate-spin" />
                  {:else}
                    <XIcon size={11} />
                  {/if}
                </Button>
              {/if}
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
                class="flex h-[34px] w-full cursor-pointer items-center justify-start gap-[9px] rounded-[9px] px-[9px] py-0 font-normal transition-colors hover:bg-[var(--wash-2)]"
                aria-label="Request a reviewer"
                aria-haspopup="menu"
                aria-expanded={reviewerMenuOpen}
                onclick={() => (reviewerMenuOpen = !reviewerMenuOpen)}
              >
                <span class="min-w-0 flex-1 truncate text-left text-muted-foreground">
                  {reviewers.length === 0
                    ? "No one requested yet"
                    : "Request another reviewer"}
                </span>
                {#if reviewerCandidatesLoading}
                  <CircleNotchIcon size={11} class="shrink-0 animate-spin text-muted-foreground" />
                {:else}
                  <span class="shrink-0 font-medium text-foreground">Request</span>
                {/if}
              </Button>
            </li>
          {/if}
        </ul>
      {/if}
      </div>

      {#if onRequestReviewer}
        <DropdownMenu.Root bind:open={reviewerMenuOpen}>
          <DropdownMenu.Content
            customAnchor={reviewerTrigger}
            side="bottom"
            align="end"
            sideOffset={6}
            class="w-52"
            aria-label="Request a reviewer"
          >
            {#if reviewerCandidatesLoading}
              <DropdownMenu.Item disabled>Loading reviewers…</DropdownMenu.Item>
            {:else if availableReviewerCandidates.length === 0}
              <DropdownMenu.Item disabled>No reviewers available</DropdownMenu.Item>
            {:else}
              {#each availableReviewerCandidates as candidate (candidate.login)}
                <DropdownMenu.Item
                  disabled={reviewerMutation === candidate.login}
                  onSelect={() => {
                    reviewerMenuOpen = false;
                    onRequestReviewer?.(candidate.login);
                  }}
                >
                  <PrAvatar
                    name={candidate.login}
                    url={candidate.avatarUrl ?? ""}
                    size="size-[20px] "
                  />
                  <span class="truncate">{candidate.login}</span>
                </DropdownMenu.Item>
              {/each}
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    </section>

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
             own scrollport rather than growing without bound: a repository with
             forty checks used to push Changed files below the fold of a rail
             that is already pinned. The fold is still the whole-section
             control.

             Folded with `hidden`, not unmounted: the list keeps its scroll
             offset, and the height it is given is computed rather than
             measured, so a hidden section still renders correctly when it comes
             back. -->
        <div
          class="-mx-[9px]"
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
                class="group/check flex items-center gap-1 rounded-[9px] pr-1 transition-colors hover:bg-[var(--wash-2)]"
              >
                <button
                  type="button"
                  disabled={!item.detailsUrl}
                  class="flex h-full min-w-0 flex-1 overflow-hidden items-center justify-start gap-[9px] rounded-[9px] px-[9px] py-0 text-left font-normal enabled:cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
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
                    class="w-[48px] shrink-0 whitespace-nowrap text-right font-mono tabular-nums text-muted-foreground opacity-80"
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
                    class="h-6 shrink-0 cursor-pointer gap-1 rounded-md px-1.5 font-medium text-(--solus-art-negative) transition-[background-color,color,scale] hover:bg-[color:color-mix(in_srgb,var(--solus-art-negative)_10%,transparent)] hover:text-(--solus-art-negative) focus-visible:ring-[color:color-mix(in_srgb,var(--solus-art-negative)_24%,transparent)] active:scale-[0.96]"
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

      <!-- No churn summary here. The meta band under the title already carries
           this pull request's totals *and* the same added/removed ratio as a
           row of squares, a few hundred pixels up the same screen — the bar was
           the third place the page said "+371 −578". The per-file counts below
           are the thing this section adds. -->
      <div class="-mx-[9px]" class:hidden={!sectionOpen.files}>
        {#if filesLoading}
          <ul class="flex flex-col" role="list">
            {#each [0, 1, 2, 3] as i (i)}
              <!-- The skeleton reserves the glyph slot too, so the text column
                   does not jump left-to-right when the files land. -->
              <li class="flex items-center gap-2.5 px-[9px] py-[7px]">
                <Skeleton class="size-3.5 shrink-0 rounded bg-muted" />
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                  <Skeleton class="h-3 rounded bg-muted" style={`width:${70 - i * 12}%`} />
                  <Skeleton class="h-2.5 rounded bg-muted" style={`width:${50 - i * 8}%`} />
                </span>
              </li>
            {/each}
          </ul>
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
                     Diff, the file picker and project search all use, so a
                     `.svelte` looks like a `.svelte` wherever you meet it in
                     the app. It falls back to a neutral document mark for a
                     type with no logo, which is what keeps the text column in
                     one edge instead of ragged.

                     The row height comes from the list's own `style`; a file at
                     the repository root has no directory line and gets the
                     short height (see lib/rail-rows). -->
                <div {style}>
                  <Button
                    type="button"
                    variant="ghost"
                    class="flex h-full w-full cursor-pointer items-center justify-start gap-2.5 rounded-[9px] px-[9px] py-0 text-left font-normal transition-colors hover:bg-[var(--wash-2)]"
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
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="min-w-0 truncate font-mono"
                        >{fileName(file.path)}</span
                      >
                      {#if dirName(file.path)}
                        <span
                          class="min-w-0 truncate text-micro font-mono text-muted-foreground opacity-75"
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
