<script lang="ts">
  import { CaretRightIcon, FileIcon } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import type { ChangedFileStat } from "../../../shared/types";
  import type { PullRequestDetail, PrReviewer } from "../../../shared/providers";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../diagram/iconify";
  import { prStatusBadge } from "../prs/lib/pr-utils";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import PrReviewStateBadge from "../prs/PrReviewStateBadge.svelte";
  import { fileName, dirName } from "./lib/activity-data";
  import { Skeleton } from "../ui/skeleton";

  // Register the lazy (~12MB) `logos` icon set so changed-file rows can resolve
  // their vibrant brand icon. Idempotent and shared across the app.
  ensureIconCollections();

  // The activity tab's right rail: status + reviewers + opened-time card, and
  // the changed-files card with the additions/deletions split bar.
  let {
    detail,
    reviewers,
    reviewersLoading,
    changedFiles,
    filesLoading,
    openedTime,
    onFileJump,
  }: {
    detail: PullRequestDetail | null;
    reviewers: PrReviewer[];
    reviewersLoading: boolean;
    changedFiles: ChangedFileStat[];
    filesLoading: boolean;
    openedTime: string | null;
    onFileJump?: (path: string) => void;
  } = $props();

  const FILES_PREVIEW = 6;
  let filesExpanded = $state(false);

  const statusBadge = $derived(prStatusBadge(detail));
  const visibleFiles = $derived(
    filesExpanded ? changedFiles : changedFiles.slice(0, FILES_PREVIEW),
  );
  const moreFiles = $derived(Math.max(0, changedFiles.length - FILES_PREVIEW));
  const totalAdds = $derived(changedFiles.reduce((sum, f) => sum + f.additions, 0));
  const totalDels = $derived(changedFiles.reduce((sum, f) => sum + f.deletions, 0));
  const addPct = $derived(
    totalAdds + totalDels > 0 ? (totalAdds / (totalAdds + totalDels)) * 100 : 0,
  );

</script>

<aside class="hidden w-[16.5rem] shrink-0 lg:block">
  <div class="sticky top-9 flex flex-col gap-5">
    <!-- Status / reviewers / opened — a flat properties list, no card chrome -->
    <dl class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <dt class="text-xs text-(--solus-text-tertiary)">Status</dt>
        {#if statusBadge}
          {@const Badge = statusBadge.Icon}
          <dd>
            <span
              class="inline-flex items-center gap-1.5 rounded-full py-1 pr-2 pl-1 text-[0.75rem] font-medium leading-none"
              style={`color:${statusBadge.tone};background:color-mix(in srgb,${statusBadge.tone} 12%,transparent)`}
            >
              <Badge size={12} weight="fill" class="shrink-0" />
              {statusBadge.label}
            </span>
          </dd>
        {/if}
      </div>

      <div>
        <dt class="mb-1.5 text-xs text-(--solus-text-tertiary)">Reviewers</dt>
          <dd>
            {#if reviewersLoading}
              <div class="flex items-center gap-2">
                <Skeleton class="size-5 shrink-0 rounded-full bg-(--solus-art-border)" />
                <Skeleton class="h-3 w-24 rounded bg-(--solus-art-border)" />
              </div>
            {:else if reviewers.length === 0}
              <span class="text-[0.75rem] text-(--solus-text-tertiary)">None</span>
            {:else}
              <ul class="flex flex-col gap-1.5" role="list">
                {#each reviewers as reviewer (reviewer.login)}
                  <li class="flex items-center gap-2">
                    <PrAvatar name={reviewer.login} size="size-5 text-[0.5rem]" />
                    <span class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-secondary)"
                      >{reviewer.login}</span
                    >
                    <PrReviewStateBadge state={reviewer.state} />
                  </li>
                {/each}
              </ul>
            {/if}
          </dd>
        </div>
      {#if openedTime}
        <div class="flex items-center justify-between gap-3">
          <dt class="shrink-0 text-xs text-(--solus-text-tertiary)">Opened</dt>
          <dd class="text-[0.75rem] text-(--solus-text-secondary)">
            {openedTime}
          </dd>
        </div>
      {/if}
    </dl>

    <!-- Changed files -->
    <section class="border-t border-(--solus-art-border) pt-5">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-[0.6875rem] font-semibold tracking-wider text-(--solus-text-tertiary) uppercase">
          Changed files
        </h3>
        {#if filesLoading}
          <Skeleton class="h-[1.125rem] w-5 rounded-full bg-(--solus-art-border)" />
        {:else}
          <span
            class="grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-(--solus-art-raised) px-1 text-[0.625rem] font-semibold tabular-nums text-(--solus-text-secondary)"
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

      <ul class="-mx-2 mt-2 flex flex-col gap-px" role="list">
        {#if filesLoading}
          {#each [0, 1, 2, 3] as i (i)}
            <li class="flex items-center gap-2 px-2 py-1.5">
              <Skeleton class="size-3.5 shrink-0 rounded bg-(--solus-art-border)" />
              <Skeleton class="h-3 rounded bg-(--solus-art-border)" style={`width:${70 - i * 12}%`} />
            </li>
          {/each}
        {/if}
        {#each visibleFiles as file (file.path)}
          {@const icon = fileTypeIcon(file.path)}
          <li>
            <button
              type="button"
              class="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--solus-accent-light)"
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
            </button>
          </li>
        {/each}
        {#if moreFiles > 0}
          <li>
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-secondary)"
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
            </button>
          </li>
        {/if}
      </ul>
    </section>
  </div>
</aside>
