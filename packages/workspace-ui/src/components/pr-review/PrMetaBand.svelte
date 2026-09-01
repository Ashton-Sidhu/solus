<script lang="ts">
  import { ArrowRight as ArrowRightIcon } from "@lucide/svelte";
  import { Skeleton } from "../ui/skeleton";
  import { changeBlocks } from "./lib/change-blocks";

  /**
   * The facts about the change, banded under the title: which branches, how
   * many files, how much churn. They used to run together in the subtitle with
   * the author and the state, where a long ref pushed the counts off the line
   * and nothing was labelled — so the numbers only meant something if you
   * already knew which one was which.
   *
   * Three labelled cells, ruled above and below, divided by hairlines. The band
   * is a band, not a card: it separates the title from the description without
   * introducing a second kind of surface on a page that has no other.
   *
   * ── The stacked rung (`@max-[30rem]/pane`) ──
   * Three cells do not fit on one line below 30rem, and the cell that loses is
   * always Branch, because a generated head ref is routinely 50 characters. So
   * the band breaks rather than truncates: Branch takes a row of its own and
   * wraps, then Files and Changes split the row under it. The head ref gives up
   * its 26ch cap there — the cap exists to stop it pushing the other two cells
   * off the line, and on its own row there is nothing left to push.
   */
  let {
    headBranch,
    baseRef,
    fileCount,
    filesLoading,
    additions,
    deletions,
  }: {
    headBranch: string;
    baseRef: string;
    fileCount: number;
    filesLoading: boolean;
    additions: number;
    deletions: number;
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

<!-- One letterspaced micro-caption, written once and rendered three times, so
     the cells cannot drift apart. It is the review's label rung (ADR-0013) —
     one step under the values it names, at every display width.

     The band is two sizes and only two: caption, then value. Every value —
     both refs, the file count, the churn — sits on the row rung, so the cells
     read as one band with one ladder. The refs used to take the meta rung a
     step below that, which put the band's *lead* fact, the one you copy and
     the one that sets the band's width, in the smallest type on the row. -->
{#snippet caption(label: string)}
  <span
    class="text-micro font-medium tracking-[0.12em] text-muted-foreground uppercase"
  >
    {label}
  </span>
{/snippet}

<!-- The band declares its own size and the cells inherit it (ADR-0013). Cell
     padding steps down on a laptop display, where the reading column is
     narrower and this band would otherwise eat a line of the description. -->
<div
  class="mt-[22px] flex flex-wrap items-stretch border-y border-[var(--hairline)] text-review-row [.is-laptop-display_&]:mt-4"
>
  <!-- Branch. The head ref is a literal you might need to type, so the whole
       cell is the copy target rather than hiding the action behind a glyph. -->
  <div
    class="flex min-w-0 flex-1 flex-col gap-1.5 py-3 pr-[22px] @max-[30rem]/pane:basis-full @max-[30rem]/pane:pr-0 [.is-laptop-display_&]:py-2.5 [.is-laptop-display_&]:pr-4"
  >
    {@render caption("Branch")}
    <button
      type="button"
      class="-ml-[5px] flex min-w-0 items-center gap-[7px] overflow-hidden rounded-md px-[5px] py-0.5 text-left transition-colors hover:bg-[var(--wash-2)] disabled:cursor-default disabled:hover:bg-transparent @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:gap-y-0.5"
      disabled={!headBranch}
      title={headBranch ? `Copy ${headBranch}` : undefined}
      onclick={copyBranch}
    >
      {#if headBranch}
        <!-- The head ref is capped at a measure rather than left to flex: a
             generated branch name is long enough to push the base ref and the
             receipt off the line, and the tail is the disposable half. -->
        <span
          class="min-w-0 max-w-[26ch] truncate font-mono @max-[30rem]/pane:max-w-none @max-[30rem]/pane:overflow-visible @max-[30rem]/pane:break-all @max-[30rem]/pane:text-clip @max-[30rem]/pane:whitespace-normal"
          >{headBranch}</span
        >
        <ArrowRightIcon
          size={11}
          class="shrink-0 text-muted-foreground opacity-55"
          aria-hidden="true"
        />
      {/if}
      <span class="shrink-0 font-mono">{baseRef}</span>
      <!-- The receipt sits inside the control that produced it and holds its
           own width, so confirming a copy never re-flows the ref beside it. -->
      <span
        class="w-[34px] shrink-0 text-muted-foreground opacity-80 transition-opacity duration-150"
        class:opacity-0={!copied}
        aria-live="polite"
      >
        {copied ? "copied" : ""}
      </span>
    </button>
  </div>

  <!-- Between Branch and Files this rule is the wrap itself once the band
       breaks, so the two cells below take a top hairline instead. -->
  <span
    class="w-px shrink-0 bg-[var(--hairline)] @max-[30rem]/pane:hidden"
    aria-hidden="true"
  ></span>

  <!-- Files -->
  <div
    class="flex shrink-0 flex-col gap-1.5 px-[22px] py-3 @max-[30rem]/pane:flex-1 @max-[30rem]/pane:basis-0 @max-[30rem]/pane:border-t @max-[30rem]/pane:border-[var(--hairline)] @max-[30rem]/pane:pl-0 [.is-laptop-display_&]:px-4 [.is-laptop-display_&]:py-2.5"
  >
    {@render caption("Files")}
    {#if filesLoading}
      <Skeleton class="h-4 w-12 rounded bg-muted" />
    {:else}
      <span class="font-medium tabular-nums">
        {fileCount}
        {fileCount === 1 ? "file" : "files"}
      </span>
    {/if}
  </div>

  <span
    class="w-px shrink-0 bg-[var(--hairline)] @max-[30rem]/pane:border-t @max-[30rem]/pane:border-[var(--hairline)]"
    aria-hidden="true"
  ></span>

  <!-- Changes: the counts, then the same ratio as a short row of squares. -->
  <div
    class="flex shrink-0 flex-col gap-1.5 py-3 pl-[22px] @max-[30rem]/pane:flex-1 @max-[30rem]/pane:basis-0 @max-[30rem]/pane:border-t @max-[30rem]/pane:border-[var(--hairline)] [.is-laptop-display_&]:py-2.5 [.is-laptop-display_&]:pl-4"
  >
    {@render caption("Changes")}
    {#if filesLoading}
      <Skeleton class="h-4 w-16 rounded bg-muted" />
    {:else if hasChurn}
      <span class="flex items-center gap-[9px]">
        <span class="font-mono tabular-nums">
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
      </span>
    {:else}
      <span class="text-muted-foreground">No changes</span>
    {/if}
  </div>
</div>
