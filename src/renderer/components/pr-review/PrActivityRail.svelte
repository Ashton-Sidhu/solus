<script lang="ts">
  import { localApi } from "@client-core/local-api";
  import {
    CaretRightIcon,
    CircleNotchIcon,
    FileIcon,
  } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import type { Snippet } from "svelte";
  import type { ChangedFileStat } from "../../../shared/types";
  import type { CheckItem, PrChecksSummary } from "../../../shared/checks-types";
  import type { PullRequestDetail, PrReviewer } from "../../../shared/providers";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { ensureIconCollections } from "../diagram/iconify";
  import { Button } from "../ui/button";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import PrReviewStateBadge from "../prs/PrReviewStateBadge.svelte";
  import { checkDuration, orderedChecks } from "../prs/lib/checks";
  import { fileName, dirName } from "./lib/activity-data";
  import { Skeleton } from "../ui/skeleton";

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
    changedFiles,
    filesLoading,
    openedTime,
    checks,
    unresolvedCount,
    onFileJump,
    actions,
  }: {
    detail: PullRequestDetail | null;
    reviewers: PrReviewer[];
    reviewersLoading: boolean;
    changedFiles: ChangedFileStat[];
    filesLoading: boolean;
    openedTime: string | null;
    checks?: PrChecksSummary;
    unresolvedCount: number;
    onFileJump?: (path: string) => void;
    /** The PR's action cluster (merge CTA + quiet secondary row) — it lives
     *  with the readiness status it acts on, Linear-style, not in the header. */
    actions?: Snippet;
  } = $props();

  const FILES_PREVIEW = 6;
  const CHECKS_PREVIEW = 4;
  let filesExpanded = $state(false);
  let checksExpanded = $state(false);

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
      : readyToMerge || detail.state === "merged"
        ? "var(--solus-art-positive)"
        : blocked
          ? "var(--solus-art-negative)"
          : "var(--muted-foreground)",
  );
  const visibleFiles = $derived(
    filesExpanded ? changedFiles : changedFiles.slice(0, FILES_PREVIEW),
  );
  const moreFiles = $derived(Math.max(0, changedFiles.length - FILES_PREVIEW));
  const totalAdds = $derived(changedFiles.reduce((sum, f) => sum + f.additions, 0));
  const totalDels = $derived(changedFiles.reduce((sum, f) => sum + f.deletions, 0));
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
  <div class="mb-2.5 flex items-center gap-2">
    <h3
      class="text-[9.5px] font-medium tracking-widest text-muted-foreground uppercase"
    >
      {label}
    </h3>
    {#if trailing}
      <span class="ml-auto shrink-0">{@render trailing()}</span>
    {/if}
  </div>
{/snippet}

<!-- How the merge will be recorded, stated where the section names it rather
     than only inside the button's menu. -->
{#snippet mergeMethodNote()}
  <span class="font-mono text-[10.5px] text-muted-foreground opacity-75">
    {detail?.state === "merged" ? "squashed" : blocked ? "rebase" : "squash"}
  </span>
{/snippet}

<!-- The rail is never lost: below the review's ~1000px it folds under the main
     column at full width instead of hiding. -->
<aside class="w-[clamp(280px,22%,360px)] shrink-0 @max-[1000px]:w-full">
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
      {@render sectionHead("Merge", mergeMethodNote)}

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
            <span class="text-[13.5px] font-semibold tracking-[-0.01em]">
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
              class="text-[11.5px] leading-[1.55] text-pretty tabular-nums text-muted-foreground"
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

      {#if actions}
        <div class="mt-3.5">{@render actions()}</div>
      {/if}

      <div class="mt-[22px] h-px bg-[var(--hairline)]" aria-hidden="true"></div>
    </section>

    <!-- Reviewers -->
    <section>
      {#snippet reviewerCount()}
        <span class="text-[11px] tabular-nums text-muted-foreground">
          {approvedReviewers} of {reviewers.length} approved
        </span>
      {/snippet}
      {@render sectionHead(
        "Reviewers",
        !reviewersLoading && reviewers.length > 0 ? reviewerCount : undefined,
      )}
      {#if reviewersLoading}
        <div class="flex items-center gap-2 px-2">
          <Skeleton class="size-[22px] shrink-0 rounded-full bg-muted" />
          <Skeleton class="h-3 w-24 rounded bg-muted" />
        </div>
      {:else if reviewers.length === 0}
        <p class="px-2 text-[11.5px] text-muted-foreground">No reviewers yet</p>
      {:else}
        <ul class="-mx-2 flex flex-col" role="list">
          {#each reviewers as reviewer (reviewer.login)}
            <li class="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
              <PrAvatar name={reviewer.login} size="size-[22px] text-[10px]" />
              <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                {reviewer.login}
              </span>
              <PrReviewStateBadge state={reviewer.state} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Checks -->
    {#if allChecks.length > 0}
      <section>
        {#snippet checksCount()}
          <!-- All-green states earn the positive tint; anything short of that
               stays neutral so the colour keeps meaning something. -->
          <span
            class="text-[11px] font-medium tabular-nums {checks?.state ===
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
                  <span class="min-w-0 flex-1 truncate text-[12.5px]">
                    {item.name}
                  </span>
                  {#if item.inFlight}
                    <CircleNotchIcon
                      size={10}
                      class="shrink-0 animate-spin text-chart-2 [animation-duration:0.9s]"
                    />
                  {:else if duration}
                    <span
                      class="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground"
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
                  class="flex h-[26px] w-full cursor-pointer items-center justify-start gap-1.5 rounded-md border-0 bg-transparent px-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
          <span class="font-mono text-[10.5px] tabular-nums text-muted-foreground">
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
            class="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums"
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
                    class="min-w-0 truncate text-[12.5px] font-medium group-hover:text-primary"
                    >{fileName(file.path)}</span
                  >
                  <span
                    class="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums"
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
                    class="truncate font-mono text-[10px] text-muted-foreground"
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
              class="flex h-[26px] w-full cursor-pointer items-center justify-start gap-1.5 rounded-md border-0 bg-transparent px-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
