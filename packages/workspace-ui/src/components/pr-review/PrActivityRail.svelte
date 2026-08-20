<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import {
    ChevronRight as CaretRightIcon,
    LoaderCircle as CircleNotchIcon,
    File as FileIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import Icon from "@iconify/svelte";
  import type { Snippet } from "svelte";
  import type { ChangedFileStat } from "@solus/contracts/types";
  import type { CheckItem, PrChecksSummary } from "@solus/contracts/checks-types";
  import type {
    PullRequestDetail,
    PrReviewer,
    PrReviewerCandidate,
  } from "@solus/contracts/providers";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { changedFileTotals } from "../../lib/diff-stats";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { ensureIconCollections } from "../diagram/iconify";
  import { Button } from "../ui/button";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import { checkDuration, orderedChecks } from "../prs/lib/checks";
  import { reviewerStateColor, reviewerStateLabel } from "./lib/reviewer-state";
  import { fileName, dirName } from "./lib/activity-data";
  import { Skeleton } from "../ui/skeleton";
  import * as DropdownMenu from "../ui/dropdown-menu";

  // Register the small offline icon subset used by changed-file rows.
  ensureIconCollections();

  // The activity tab's right rail: four flat sections in one column — merge
  // readiness (the only one you act on), reviewers, checks, and the changed
  // files with the additions/deletions split bar. No section gets a surface of
  // its own; label-then-content and a closing hairline carry the structure.
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
    unresolvedCount,
    onFileJump,
    actions,
    menu,
  }: {
    detail: PullRequestDetail | null;
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
    unresolvedCount: number;
    onFileJump?: (path: string) => void;
    /** The PR's action cluster (merge CTA + quiet secondary row) — it lives
     *  with the readiness status it acts on, Linear-style, not in the header. */
    actions?: Snippet;
    /** The ⋯ menu of rarely-used PR actions. It rides in this section's own
     *  header, where it is always present, rather than under a cluster that a
     *  draft or a closed PR leaves empty. */
    menu?: Snippet;
  } = $props();

  const FILES_PREVIEW = 6;
  const CHECKS_PREVIEW = 4;
  let filesExpanded = $state(false);
  let checksExpanded = $state(false);
  let reviewerMenuOpen = $state(false);
  let reviewerTrigger = $state<HTMLButtonElement | null>(null);

  // Failing checks lead, so the 4-row preview always shows what's broken rather
  // than whichever four the host happened to list first.
  const allChecks = $derived(orderedChecks(checks));
  const checkItems = $derived(
    checksExpanded ? allChecks : allChecks.slice(0, CHECKS_PREVIEW),
  );
  const moreChecks = $derived(Math.max(0, allChecks.length - CHECKS_PREVIEW));
  const passedChecks = $derived(
    allChecks.filter(
      (item) =>
        item.conclusion === "success" ||
        item.conclusion === "neutral" ||
        item.conclusion === "skipped",
    ).length,
  );
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
  const checksCurrent = $derived(
    !checks || !detail || checks.headSha === detail.headSha,
  );
  const readyToMerge = $derived(
    detail?.state === "open" &&
      !detail.draft &&
      detail.mergeable !== false &&
      detail.mergeStateStatus !== "dirty" &&
      checks?.state !== "failing" &&
      checks?.state !== "pending" &&
      checksCurrent &&
      unresolvedCount === 0,
  );
  const blocked = $derived(
    !!detail &&
      (detail.mergeStateStatus === "dirty" ||
        detail.mergeable === false ||
        checks?.state === "failing"),
  );
  // The status dot's colour, as the design system's dot-plus-halo pair.
  const statusColor = $derived(
    !detail
      ? null
      : detail.state === "merged"
        ? "var(--review)"
        : readyToMerge
        ? "var(--solus-art-positive)"
        : blocked
          ? "var(--solus-art-negative)"
          : "var(--muted-foreground)",
  );
  const visibleFiles = $derived(
    filesExpanded ? changedFiles : changedFiles.slice(0, FILES_PREVIEW),
  );
  const moreFiles = $derived(Math.max(0, changedFiles.length - FILES_PREVIEW));
  const fileTotals = $derived(changedFileTotals(changedFiles));
  const totalAdds = $derived(fileTotals.additions);
  const totalDels = $derived(fileTotals.deletions);
  const addPct = $derived(
    totalAdds + totalDels > 0 ? (totalAdds / (totalAdds + totalDels)) * 100 : 0,
  );

  function openCheck(item: CheckItem) {
    if (!item.detailsUrl) return;
    void localApi.openExternal(item.detailsUrl);
    requestInputFocus();
  }
</script>

<!-- Section label: the design system's letterspaced micro-caption with its own
     count on the right. No rule — the gap between sections separates them. -->
{#snippet sectionHead(label: string, trailing?: Snippet)}
  <div class="text-xs mb-2.5 flex items-center gap-2">
    <h3
      class="font-medium st text-muted-foreground uppercase"
    >
      {label}
    </h3>
    {#if trailing}
      <span class="ml-auto shrink-0">{@render trailing()}</span>
    {/if}
  </div>
{/snippet}

<!-- How the merge will be recorded, stated where the section names it rather
     than only inside the button's menu — and only while there is a merge to
     record. A draft has no merge button, so naming a method there was a fact
     about a thing that is not on offer yet. -->
{#snippet mergeSectionTrailing()}
  <span class="text-xs flex items-center gap-2.5">
    {#if detail?.state === "merged" || (detail?.state === "open" && !detail.draft)}
      <span class="text-muted-foreground opacity-75">
        {detail.state === "merged" ? "squashed" : blocked ? "rebase" : "squash"}
      </span>
    {/if}
    {#if menu}{@render menu()}{/if}
  </span>
{/snippet}

<!-- The rail is never lost: below the review's ~1000px it folds under the main
     column at full width instead of hiding. -->
<aside class="text-xs w-[var(--pr-activity-rail-width)] [--pr-activity-rail-width:clamp(280px,22%,360px)] shrink-0 [.is-laptop-display_&]:[--pr-activity-rail-width:clamp(260px,20%,320px)] @max-[1000px]:w-full">
  <!-- The cap is what makes `sticky` safe. Pinned at top:0, a rail taller than
       the scrollport never moves, so everything past the fold — the tail of an
       expanded checks list, and all of Changed files — becomes unreachable.
       Capping it gives the rail its own scroll instead. Only while it *is* a
       rail: below 1000px it folds under the main column at full width, where a
       second scrollbox would be wrong. -->
  <div
    class="sticky top-0 flex flex-col gap-[26px] overflow-x-hidden @min-[1001px]:max-h-screen @min-[1001px]:overflow-y-auto @min-[1001px]:overscroll-contain"
  >
    <!-- Merge readiness. No surface of its own: the rail's other sections are
         plain label-then-content, and a washed card here made the one thing you
         act on look like a different kind of object than the rest of the column.
         The state is carried by a 7px keyline dot instead of a filled disc —
         the same speck the crumb and the list rows use, so one status vocabulary
         runs from the list through to here. A hairline closes the section, which
         is what separates it from Reviewers without a box. -->
    <section class="flex flex-col">
      {@render sectionHead("Merge", mergeSectionTrailing)}

      <div class="flex items-start gap-[9px]">
        {#if !detail}
          <Skeleton class="mt-[5px] size-[7px] shrink-0 rounded-full bg-muted" />
        {:else}
          <span
            class="mt-[5px] size-[7px] shrink-0 rounded-full"
            style={`background:${statusColor}`}
            aria-hidden="true"
          ></span>
        {/if}
        <div class="flex min-w-0 flex-col gap-[3px]">
          {#if !detail}
            <Skeleton class="h-3.5 w-28 rounded bg-muted" />
            <Skeleton class="mt-1 h-3 w-20 rounded bg-muted" />
          {:else}
            <span class="text-sm font-medium ">
              {detail.state === "merged"
                ? "Merged into " + (detail.baseRef ?? "main")
                : detail.state === "closed"
                  ? "Closed"
                  : detail.draft
                    ? "Still a draft"
                    : readyToMerge
                      ? "Ready to merge"
                      : blocked && checks?.state === "failing"
                        ? "Checks need attention"
                        : blocked
                          ? "Conflicts with " + (detail.baseRef ?? "main")
                          : "Review in progress"}
            </span>
            <span
              class="leading-[1.55] text-pretty tabular-nums text-muted-foreground"
            >
              {#if checks?.state === "passing"}
                {passedChecks} {passedChecks === 1 ? "check" : "checks"} passed · no conflicts
              {:else if !checksCurrent}
                Checks are refreshing
              {:else if checks?.state === "pending"}
                Checks are still running
              {:else if unresolvedCount > 0}
                {unresolvedCount} unresolved {unresolvedCount === 1 ? "thread" : "threads"}
              {:else if openedTime}
                Opened {openedTime}
              {/if}
            </span>
          {/if}
        </div>
      </div>

      {#if actions}{@render actions()}{/if}

      <div class="mt-[22px] h-px bg-[var(--hairline)]" aria-hidden="true"></div>
    </section>

    <!-- Reviewers. One 30px row per person: avatar, login, and the verdict as a
         single lower-case word in its own colour. The section's action is a word
         ("Request"), not a glyph — it is the only thing you can do here, and the
         rail has no other icon buttons to read it against. -->
    <section>
      {#snippet reviewerActions()}
        {#if onRequestReviewer}
          <Button
            bind:ref={reviewerTrigger}
            type="button"
            variant="ghost"
            class="h-auto cursor-pointer p-0  font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            aria-label="Request a reviewer"
            aria-haspopup="menu"
            aria-expanded={reviewerMenuOpen}
            onclick={() => (reviewerMenuOpen = !reviewerMenuOpen)}
          >
            {#if reviewerCandidatesLoading}
              <CircleNotchIcon size={11} class="animate-spin" />
            {/if}
            Request
          </Button>
        {/if}
      {/snippet}
      {#snippet reviewerCount()}
        <span class="tabular-nums text-muted-foreground">
          {approvedReviewers} of {reviewers.length} approved
        </span>
      {/snippet}
      {@render sectionHead(
        "Reviewers",
        onRequestReviewer
          ? reviewerActions
          : !reviewersLoading && reviewers.length > 0
            ? reviewerCount
            : undefined,
      )}
      {#if reviewersLoading}
        <div class="flex h-[30px] items-center gap-[9px] px-2">
          <Skeleton class="size-5 shrink-0 rounded-full bg-muted" />
          <Skeleton class="h-3 w-24 rounded bg-muted" />
        </div>
      {:else if reviewers.length === 0}
        <p class="px-2  text-muted-foreground">
          No one requested yet
        </p>
      {:else}
        <ul class="-mx-2 flex flex-col" role="list">
          {#each reviewers as reviewer (reviewer.login)}
            <li
              class="group/reviewer flex h-[30px] items-center gap-[9px] rounded-md px-2 transition-colors hover:bg-[var(--wash-1)]"
            >
              <PrAvatar name={reviewer.login} size="size-5 " />
              <span class="min-w-0 flex-1 truncate text-sm">
                {reviewer.login}
              </span>
              <span
                class="shrink-0  whitespace-nowrap"
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
        </ul>
      {/if}

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
      <section>
        {#snippet checksCount()}
          <!-- All-green states earn the positive tint; anything short of that
               stays neutral so the colour keeps meaning something. -->
          <span
            class="font-medium tabular-nums {checks?.state ===
 'passing'
 ? 'text-(--solus-art-positive)'
 : 'text-muted-foreground'}"
          >
            {#if checks?.state === "passing"}
              {passedChecks} passing
            {:else}
              {passedChecks} of {allChecks.length} passed
            {/if}
          </span>
        {/snippet}
        {@render sectionHead("Checks", checksCount)}

        <!-- The list always shows. Hiding it behind a toggle while everything
             passes makes the green state the only one you cannot inspect, and
             the section header already says how many there are. -->
        <ul class="-mx-2 flex flex-col" role="list">
            {#each checkItems as item (item.id)}
              {@const duration = checkDuration(item)}
              {@const passed =
                item.conclusion === "success" ||
                item.conclusion === "neutral" ||
                item.conclusion === "skipped"}
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!item.detailsUrl}
                  class="group flex w-full items-center justify-start gap-2.5 rounded-lg px-2 py-1.5 text-left font-normal transition-colors enabled:cursor-pointer enabled:hover:bg-muted disabled:cursor-default"
                  onclick={() => openCheck(item)}
                >
                  <!-- A dot with the design system's halo: this list is scanned
                       as a column of states, and the colour alone carries it. -->
                  <span
                    class="size-1.5 shrink-0 rounded-full {item.inFlight
 ? 'animate-pulse bg-chart-2'
 : passed
 ? 'bg-(--solus-art-positive)'
 : 'bg-(--solus-art-negative)'}"
                    aria-hidden="true"
                  ></span>
                  <span class="min-w-0 flex-1 truncate text-sm">
                    {item.name}
                  </span>
                  {#if item.inFlight}
                    <CircleNotchIcon
                      size={10}
                      class="shrink-0 animate-spin text-chart-2 [animation-duration:0.9s]"
                    />
                  {:else if duration}
                    <span
                      class="shrink-0  tabular-nums text-muted-foreground"
                    >
                      {duration}
                    </span>
                  {/if}
                </Button>
              </li>
            {/each}
            {#if moreChecks > 0}
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  class="flex h-[26px] w-full cursor-pointer items-center justify-start gap-1.5 rounded-md border-0 bg-transparent px-2  font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onclick={() => (checksExpanded = !checksExpanded)}
                >
                  <CaretRightIcon
                    size={10}
                    class={`transition-transform ${checksExpanded ? "rotate-90" : ""}`}
                  />
                  {checksExpanded
                    ? "Show fewer checks"
                    : `${moreChecks} more ${moreChecks === 1 ? "check" : "checks"}`}
                </Button>
              </li>
            {/if}
        </ul>
      </section>
    {/if}

    <!-- Changed files -->
    <section>
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
      {@render sectionHead("Changed files", fileCount)}

      {#if totalAdds + totalDels > 0}
        <div class="mb-2 flex items-center gap-2">
          <span class="flex h-[5px] flex-1 overflow-hidden rounded-full bg-muted">
            {#if totalAdds}
              <span class="h-full bg-(--solus-art-positive)" style={`width:${addPct}%`}></span>
            {/if}
            {#if totalDels}
              <span class="h-full bg-(--solus-art-negative)" style={`width:${100 - addPct}%`}></span>
            {/if}
          </span>
          <span
            class="flex shrink-0 items-center gap-1.5  tabular-nums"
          >
            {#if totalAdds}<span class="text-(--solus-art-positive)">+{totalAdds}</span>{/if}
            {#if totalDels}<span class="text-(--solus-art-negative)">−{totalDels}</span>{/if}
          </span>
        </div>
      {/if}

      <ul class="-mx-2 flex flex-col" role="list">
        {#if filesLoading}
          {#each [0, 1, 2, 3] as i (i)}
            <li class="flex items-center gap-2 px-2 py-1.5">
              <Skeleton class="size-3.5 shrink-0 rounded bg-muted" />
              <Skeleton class="h-3 rounded bg-muted" style={`width:${70 - i * 12}%`} />
            </li>
          {/each}
        {/if}
        {#each visibleFiles as file (file.path)}
          {@const icon = fileTypeIcon(file.path)}
          <li>
            <!-- Two lines: the filename carries the churn on its own baseline,
                 the directory sits under it in mono. Rail paths are long and a
                 single line would truncate the part that identifies the file. -->
            <Button
              type="button"
              variant="ghost"
              class="group flex h-auto w-full cursor-pointer items-start justify-start gap-2.5 rounded-lg px-2 py-2 text-left font-normal transition-colors hover:bg-muted"
              onclick={() => onFileJump?.(file.path)}
            >
              {#if icon}
                <Icon {icon} width="14" height="14" class="mt-px shrink-0" />
              {:else}
                <FileIcon
                  size={14}
                  class="mt-px shrink-0 text-muted-foreground"
                />
              {/if}
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="flex items-baseline gap-2">
                  <span
                    class="min-w-0 truncate text-sm font-medium group-hover:text-primary"
                    >{fileName(file.path)}</span
                  >
                  <span
                    class="flex shrink-0 items-center gap-1.5  tabular-nums"
                  >
                    {#if file.additions}<span
                        class="text-(--solus-art-positive)">+{file.additions}</span
                      >{/if}
                    {#if file.deletions}<span
                        class="text-(--solus-art-negative)">−{file.deletions}</span
                      >{/if}
                  </span>
                </span>
                {#if dirName(file.path)}
                  <span
                    class="truncate font-mono  text-muted-foreground"
                    >{dirName(file.path).replace(/\/$/, "")}</span
                  >
                {/if}
              </span>
            </Button>
          </li>
        {/each}
        {#if moreFiles > 0}
          <li>
            <Button
              type="button"
              variant="ghost"
              class="flex h-[26px] w-full cursor-pointer items-center justify-start gap-1.5 rounded-md border-0 bg-transparent px-2  font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onclick={() => (filesExpanded = !filesExpanded)}
            >
              <CaretRightIcon
                size={10}
                class={`transition-transform ${filesExpanded ? "rotate-90" : ""}`}
              />
              {filesExpanded
                ? "Show fewer files"
                : `${moreFiles} more ${moreFiles === 1 ? "file" : "files"}`}
            </Button>
          </li>
        {/if}
      </ul>
    </section>
  </div>
</aside>
