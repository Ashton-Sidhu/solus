<script lang="ts">
  import {
    ArrowRight as ArrowRightIcon,
    Check as CheckIcon,
    Copy as CopyIcon,
    Diff as DiffIcon,
    File as FileIcon,
    GitBranch as GitBranchIcon,
  } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import { Skeleton } from "../ui/skeleton";
  import { changeBlocks } from "./lib/change-blocks";

  /**
   * The facts about the change, under the author: which branch is landing
   * where, how many files, how much churn. Three captioned rows in one
   * two-column list, each caption led by its glyph, so the eye reads down one
   * edge of labels and across to the facts.
   *
   * `leading` is a row the host adds ahead of these — the reviewers, once the
   * pane is too narrow to keep them in a rail — rendered inside this list so
   * it shares the caption column rather than starting a second one.
   *
   * Metadata, so it reads at the meta rung (`text-xs`) rather than at the
   * chrome rung the rail's rows take. The head ref is a literal a reader may
   * need to type, so the whole branch row is the copy target. Long refs stay on
   * one line and truncate at the start, where their generated prefixes carry
   * less identifying information than their suffixes. The receipt shows in
   * place of the copy glyph.
   */
  let {
    headBranch,
    baseRef,
    fileCount,
    filesLoading,
    additions,
    deletions,
    leading,
  }: {
    headBranch: string;
    baseRef: string;
    fileCount: number;
    filesLoading: boolean;
    additions: number;
    deletions: number;
    /** A `dt` + `dd` pair rendered as the list's first row. */
    leading?: Snippet;
  } = $props();

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const blocks = $derived(changeBlocks(additions, deletions));
  const hasChurn = $derived(additions + deletions > 0);

  async function copyBranch() {
    if (!headBranch) return;
    try {
      await navigator.clipboard?.writeText(headBranch);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1400);
    } catch {}
  }

  $effect(() => () => clearTimeout(copyTimer));
</script>

<!-- Captions take a fixed column so the facts share one left edge. -->
<dl
  class="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-7 gap-y-1.5 text-xs text-muted-foreground"
>
  {#if leading}{@render leading()}{/if}

  <dt class="flex items-center gap-2">
    <GitBranchIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
    Branch
  </dt>
  <dd class="flex min-h-6 min-w-0 items-center">
    <button
      type="button"
      class="group/branch -mx-1.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5 text-left font-mono text-foreground transition-colors hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-default disabled:hover:bg-transparent"
      disabled={!headBranch}
      title={headBranch ? `Copy ${headBranch}` : undefined}
      onclick={copyBranch}
    >
      {#if headBranch}
        <span
          class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl] [unicode-bidi:plaintext]"
        >{headBranch}</span>
        <ArrowRightIcon
          size={11}
          class="shrink-0 text-muted-foreground opacity-60"
          aria-hidden="true"
        />
      {/if}
      <span class="shrink-0 whitespace-nowrap text-muted-foreground">{baseRef}</span>
      {#if headBranch}
        <span class="grid size-3 shrink-0 place-items-center" aria-hidden="true">
          {#if copied}
            <CheckIcon size={11} class="text-(--solus-art-positive)" />
          {:else}
            <CopyIcon
              size={10}
              class="opacity-0 transition-opacity group-hover/branch:opacity-70 group-focus-visible/branch:opacity-70"
            />
          {/if}
        </span>
      {/if}
      <span class="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  </dd>

  <dt class="flex items-center gap-2">
    <FileIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
    Files
  </dt>
  <dd class="flex min-h-6 min-w-0 items-center tabular-nums text-foreground">
    {#if filesLoading}
      <Skeleton class="h-3 w-12 rounded bg-muted" />
    {:else}
      {fileCount}
      {fileCount === 1 ? "file" : "files"}
    {/if}
  </dd>

  <dt class="flex items-center gap-2">
    <DiffIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
    Changes
  </dt>
  <dd class="flex min-h-6 min-w-0 items-center gap-2 tabular-nums">
    {#if filesLoading}
      <Skeleton class="h-3 w-16 rounded bg-muted" />
    {:else if hasChurn}
      <!-- The counts, then the same ratio as a short row of squares. -->
      <span class="font-mono">
        <span class="text-(--solus-art-positive)">+{additions}</span>
        <span class="text-(--solus-art-negative)">−{deletions}</span>
      </span>
      <span class="flex shrink-0 gap-0.5" aria-hidden="true">
        {#each blocks as block, index (index)}
          <span
            class="size-1.5 rounded-[2px] {block === 'added'
              ? 'bg-(--solus-art-positive)'
              : 'bg-(--solus-art-negative)'}"
          ></span>
        {/each}
      </span>
    {:else}
      <span>No changes</span>
    {/if}
  </dd>
</dl>
