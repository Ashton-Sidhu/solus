<script lang="ts">
  import {
    CaretRightIcon,
    ChatCircleIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    FileIcon,
    GitPullRequestIcon,
    WarningCircleIcon,
    XCircleIcon,
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
  import { fileName, dirName } from "./lib/activity-data";
  import { Skeleton } from "../ui/skeleton";

  // Register the lazy (~12MB) `logos` icon set so changed-file rows can resolve
  // their vibrant brand icon. Idempotent and shared across the app.
  ensureIconCollections();

  // The activity tab's right rail: merge readiness, review signals (threads +
  // checks), reviewers, and the changed files with the additions/deletions
  // split bar — editorial sections set directly on the canvas.
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
  // While everything passes, the per-check list hides behind a quiet toggle —
  // the readiness headline already says "N checks passed".
  let checksListOpen = $state(false);

  const allChecks = $derived(
    checks ? [...checks.required, ...checks.optional] : [],
  );
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
    void window.solus.openExternal(item.detailsUrl);
    requestInputFocus();
  }
</script>

<aside class="hidden w-[19rem] shrink-0 lg:block">
  <!-- Editorial rail: no card — sections sit directly on the canvas, each led
       by a letterspaced label with a hairline that fades right, matching the
       main column's Activity header. -->
  <div class="sticky top-7 flex flex-col gap-7">
    <!-- Merge readiness -->
    <section>
      <div class="flex items-center gap-3">
        <p class="text-[0.6875rem] font-semibold tracking-[0.14em] text-(--solus-text-tertiary) uppercase">
          Merge readiness
        </p>
        <span
          class="h-px flex-1 bg-[linear-gradient(to_right,var(--solus-art-border),transparent)]"
          aria-hidden="true"
        ></span>
      </div>
      <div class="mt-3 flex items-start gap-3">
        {#if !detail}
          <Skeleton class="size-9 shrink-0 rounded-full bg-(--solus-art-border)" />
        {:else if readyToMerge || detail.state === "merged"}
          <span class="grid size-9 shrink-0 place-items-center rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)] text-(--solus-art-positive)">
            <CheckCircleIcon size={21} weight="fill" />
          </span>
        {:else if detail.mergeStateStatus === "dirty" || detail.mergeable === false || checks?.state === "failing"}
          <span class="grid size-9 shrink-0 place-items-center rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-negative)_10%,transparent)] text-(--solus-art-negative)">
            <WarningCircleIcon size={21} weight="fill" />
          </span>
        {:else}
          <span class="grid size-9 shrink-0 place-items-center rounded-full bg-(--solus-art-raised) text-(--solus-text-tertiary)">
            <GitPullRequestIcon size={19} weight="bold" />
          </span>
        {/if}
        <div class="min-w-0 pt-0.5">
          {#if !detail}
            <Skeleton class="mt-1 h-3.5 w-28 rounded bg-(--solus-art-border)" />
            <Skeleton class="mt-2 h-3 w-20 rounded bg-(--solus-art-border)" />
          {:else}
            <p class="text-[0.875rem] font-semibold text-(--solus-text-primary)">
              {detail.state === "merged"
                ? "Merged"
                : detail.state === "closed"
                  ? "Closed"
                  : detail.draft
                    ? "Draft in progress"
                    : readyToMerge
                      ? "Ready to merge"
                      : detail.mergeStateStatus === "dirty" || detail.mergeable === false
                        ? "Merge blocked"
                        : checks?.state === "failing"
                          ? "Checks need attention"
                          : "Review in progress"}
            </p>
            <p class="mt-0.5 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
              {#if checks?.state === "passing"}
                {passedChecks} {passedChecks === 1 ? "check" : "checks"} passed
              {:else if !checksCurrent}
                Checks are refreshing
              {:else if checks?.state === "pending"}
                Checks are still running
              {:else if unresolvedCount > 0}
                {unresolvedCount} unresolved {unresolvedCount === 1 ? "thread" : "threads"}
              {:else if openedTime}
                Opened {openedTime}
              {/if}
            </p>
          {/if}
        </div>
      </div>

      {#if actions}
        <div class="mt-4">
          {@render actions()}
        </div>
      {/if}

      <!-- Exceptions and evidence fold into readiness itself: the unresolved
           row only appears when something is unresolved, and the per-check
           list collapses behind a quiet toggle while everything passes — the
           headline above already states each fact once. -->
      {#if unresolvedCount > 0}
        <div class="mt-3 flex min-h-8 items-center gap-2.5">
          <ChatCircleIcon size={15} weight="bold" class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 text-[0.75rem] font-medium text-(--solus-text-secondary)">
            Unresolved threads
          </span>
          <span class="shrink-0 text-[0.6875rem] font-semibold tabular-nums text-(--solus-text-secondary)">
            {unresolvedCount}
          </span>
        </div>
      {/if}

      {#if allChecks.length > 0}
        {#if checks?.state === "passing"}
          <Button
            type="button"
            variant="ghost"
            class="mt-2 -ml-2 inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)"
            aria-expanded={checksListOpen}
            onclick={() => (checksListOpen = !checksListOpen)}
          >
            <CaretRightIcon
              size={11}
              weight="bold"
              class={`transition-transform ${checksListOpen ? "rotate-90" : ""}`}
            />
            {checksListOpen
              ? "Hide checks"
              : `View ${allChecks.length} ${allChecks.length === 1 ? "check" : "checks"}`}
          </Button>
        {/if}
        {#if checks?.state !== "passing" || checksListOpen}
          <ul class="-mx-2 mt-1.5 flex flex-col" role="list">
            {#each checkItems as item (item.id)}
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!item.detailsUrl}
                  class="group flex min-h-10 w-full justify-start items-center gap-2.5 rounded-lg px-2 text-left transition-[background-color,scale] duration-150 ease-out enabled:cursor-pointer enabled:hover:bg-(--solus-surface-hover) enabled:active:scale-[0.96] disabled:cursor-default"
                  onclick={() => openCheck(item)}
                >
                  {#if item.inFlight}
                    <CircleNotchIcon size={14} class="shrink-0 animate-spin text-amber-600 [animation-duration:0.9s] dark:text-amber-400" />
                  {:else if item.conclusion === "success" || item.conclusion === "neutral" || item.conclusion === "skipped"}
                    <CheckCircleIcon size={14} weight="fill" class="shrink-0 text-(--solus-art-positive)" />
                  {:else}
                    <XCircleIcon size={14} weight="fill" class="shrink-0 text-(--solus-art-negative)" />
                  {/if}
                  <span class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-secondary) group-hover:text-(--solus-text-primary)">
                    {item.name}
                  </span>
                </Button>
              </li>
            {/each}
            {#if moreChecks > 0}
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  class="flex min-h-10 w-full justify-start cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) active:scale-[0.96]"
                  onclick={() => (checksExpanded = !checksExpanded)}
                >
                  <CaretRightIcon
                    size={11}
                    weight="bold"
                    class={`transition-transform ${checksExpanded ? "rotate-90" : ""}`}
                  />
                  {checksExpanded
                    ? "Show fewer checks"
                    : `${moreChecks} more ${moreChecks === 1 ? "check" : "checks"}`}
                </Button>
              </li>
            {/if}
          </ul>
        {/if}
      {/if}
    </section>

    <!-- Reviewers -->
    <section>
      <div class="flex items-center gap-3">
        <h3 class="text-[0.6875rem] font-semibold tracking-[0.14em] text-(--solus-text-tertiary) uppercase">
          Reviewers
        </h3>
        <span
          class="h-px flex-1 bg-[linear-gradient(to_right,var(--solus-art-border),transparent)]"
          aria-hidden="true"
        ></span>
        {#if !reviewersLoading && reviewers.length > 0}
          <span class="shrink-0 text-[0.625rem] tabular-nums text-(--solus-text-tertiary)">
            {approvedReviewers} of {reviewers.length} approved
          </span>
        {/if}
      </div>
      {#if reviewersLoading}
        <div class="mt-3 flex items-center gap-2">
          <Skeleton class="size-6 shrink-0 rounded-full bg-(--solus-art-border)" />
          <Skeleton class="h-3 w-24 rounded bg-(--solus-art-border)" />
        </div>
      {:else if reviewers.length === 0}
        <p class="mt-2 text-[0.75rem] text-(--solus-text-tertiary)">No reviewers yet</p>
      {:else}
        <ul class="mt-2 flex flex-col gap-1" role="list">
          {#each reviewers as reviewer (reviewer.login)}
            <li class="flex min-h-8 items-center gap-2">
              <PrAvatar name={reviewer.login} size="size-6 text-[0.5625rem]" />
              <span class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-secondary)">
                {reviewer.login}
              </span>
              <PrReviewStateBadge state={reviewer.state} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Changed files -->
    <section>
      <div class="flex items-center gap-3">
        <h3 class="text-[0.6875rem] font-semibold tracking-[0.14em] text-(--solus-text-tertiary) uppercase">
          Changed files
        </h3>
        <span
          class="h-px flex-1 bg-[linear-gradient(to_right,var(--solus-art-border),transparent)]"
          aria-hidden="true"
        ></span>
        {#if filesLoading}
          <Skeleton class="h-3 w-5 shrink-0 rounded bg-(--solus-art-border)" />
        {:else}
          <span
            class="shrink-0 text-[0.625rem] font-semibold tabular-nums text-(--solus-text-secondary)"
          >
            {changedFiles.length}
          </span>
        {/if}
      </div>

      {#if totalAdds + totalDels > 0}
        <div class="mt-2.5 flex items-center gap-2">
          <div class="flex h-1.5 flex-1 overflow-hidden rounded-full bg-(--solus-art-raised)">
            {#if totalAdds}
              <div class="h-full bg-(--solus-art-positive)" style={`width:${addPct}%`}></div>
            {/if}
            {#if totalDels}
              <div class="h-full bg-(--solus-art-negative)" style={`width:${100 - addPct}%`}></div>
            {/if}
          </div>
          <div class="flex shrink-0 items-center gap-1.5 text-[0.6875rem] font-semibold tabular-nums">
            {#if totalAdds}<span class="text-(--solus-art-positive)">+{totalAdds}</span>{/if}
            {#if totalDels}<span class="text-(--solus-art-negative)">−{totalDels}</span>{/if}
          </div>
        </div>
      {/if}

      <ul class="-mx-2 mt-2 flex flex-col" role="list">
        {#if filesLoading}
          {#each [0, 1, 2, 3] as i (i)}
            <li class="flex min-h-9 items-center gap-2 px-2">
              <Skeleton class="size-3.5 shrink-0 rounded bg-(--solus-art-border)" />
              <Skeleton class="h-3 rounded bg-(--solus-art-border)" style={`width:${70 - i * 12}%`} />
            </li>
          {/each}
        {/if}
        {#each visibleFiles as file (file.path)}
          {@const icon = fileTypeIcon(file.path)}
          <li>
            <Button
              type="button"
              variant="ghost"
              class="group flex min-h-10 w-full justify-start cursor-pointer items-center gap-2 rounded-lg px-2 text-left transition-[background-color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) active:scale-[0.96]"
              onclick={() => onFileJump?.(file.path)}
            >
              {#if icon}
                <Icon {icon} width="14" height="14" class="shrink-0" />
              {:else}
                <FileIcon size={14} weight="regular" class="shrink-0 text-(--solus-text-tertiary)" />
              {/if}
              <span class="min-w-0 flex-1 truncate text-[0.75rem]">
                <span class="!font-normal text-(--solus-text-secondary) group-hover:text-(--solus-accent)"
                  >{fileName(file.path)}</span
                >
                {#if dirName(file.path)}
                  <span class="ml-1 font-mono text-[0.625rem] text-(--solus-text-tertiary)"
                    >{dirName(file.path).replace(/\/$/, "")}</span
                  >
                {/if}
              </span>
              {#if file.additions}
                <span class="shrink-0 tabular-nums text-[0.625rem] font-semibold text-(--solus-art-positive)"
                  >+{file.additions}</span
                >
              {/if}
              {#if file.deletions}
                <span class="shrink-0 tabular-nums text-[0.625rem] font-semibold text-(--solus-art-negative)"
                  >−{file.deletions}</span
                >
              {/if}
            </Button>
          </li>
        {/each}
        {#if moreFiles > 0}
          <li>
            <Button
              type="button"
              variant="ghost"
              class="flex min-h-10 w-full justify-start cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) active:scale-[0.96]"
              onclick={() => (filesExpanded = !filesExpanded)}
            >
              <CaretRightIcon
                size={11}
                weight="bold"
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
