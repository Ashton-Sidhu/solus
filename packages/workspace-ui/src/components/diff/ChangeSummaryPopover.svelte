<script lang="ts">
  import { GitBranch as GitBranchIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as TooltipUI from "../ui/tooltip";
  import { MiddleTruncate } from "../ui/middle-truncate";
  import { menuRowVariants } from "../ui/menu/menu-row";
  import { changeBreakdown } from "@solus/client-core/change-breakdown";
  import type { ChangedFileSummary } from "./lib/review-header";

  /**
   * What changed, and where the counts came from.
   *
   * The band shows a branch and two numbers; this is the list behind them. It
   * is a jump list, not a filter: a row scrolls the Diff view to that file. The
   * base ref lives in this footer rather than on the band, because "compared
   * against what" is asked once and then remembered. Under the heading, the
   * same counts split by kind of file — code, tests, docs — when the change
   * touches more than one.
   */
  let {
    branchLabel,
    branchTitle,
    additions,
    deletions,
    files,
    baseLabel,
    scopeLabel,
    onOpenFile,
  }: {
    branchLabel: string;
    branchTitle?: string;
    additions: number;
    deletions: number;
    files: ChangedFileSummary[];
    /** The ref this change is read against. */
    baseLabel: string;
    /** Which slice of the session the counts describe — "turn 3", "all turns". */
    scopeLabel: string;
    onOpenFile: (path: string) => void;
  } = $props();

  let open = $state(false);
  // Sorted only while the menu is open, so a streaming diff does not re-sort
  // every file on each update.
  const breakdown = $derived(open ? changeBreakdown(files, { additions, deletions }) : []);
  let triggerEl = $state<HTMLButtonElement | null>(null);
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
      <button
        {...tooltipProps}
        bind:this={triggerEl}
        type="button"
        class="no-drag grid max-w-[28rem] shrink cursor-pointer grid-cols-[auto_minmax(0,auto)_auto_auto] items-center gap-1.5 border-0 h-6.5 rounded-full bg-background px-2.5 text-workspace-chrome text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 aria-expanded:bg-[var(--wash-1)]"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${branchLabel}: ${additions} additions, ${deletions} deletions. Show changed files`}
        onclick={() => (open = !open)}
      >
        <GitBranchIcon class="size-[15px] shrink-0 text-(--solus-text-tertiary)" strokeWidth={1.5} aria-hidden="true" />
        <!-- A grid, not a flex row: the branch sits in a `minmax(0, auto)`
             column, so the chip's floor is the glyph and the counts. The
             branch gives way first and the counts are never cut. Below a
             phone-width panel the branch hides; its cell stays, so the counts
             keep their columns. -->
        <span class="flex min-w-0 overflow-hidden">
          <MiddleTruncate
            value={branchLabel}
            showTitle={false}
            class="text-(--solus-text-primary) @max-[30rem]/band:hidden"
          />
        </span>
        <span class="shrink-0 tabular-nums text-(--solus-art-3)">+{additions}</span>
        <span class="shrink-0 tabular-nums text-(--solus-stop-bg)">−{deletions}</span>
      </button>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={branchTitle ?? branchLabel} />
</TooltipUI.Root>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[min(24rem,calc(100vw-2rem))]"
  >
    <DropdownMenu.Label>Changed files · {scopeLabel}</DropdownMenu.Label>

    {#if breakdown.length > 0}
      <!-- The counts by kind, as rows shaped like the file rows below, so
           both sets of counts share one right edge. -->
      {#each breakdown as part (part.kind)}
        <div class={menuRowVariants()}>
          <span class="min-w-0 flex-1 truncate text-(--solus-text-primary)">{part.label}</span>
          <span class="shrink-0 tabular-nums text-(--solus-art-3)">+{part.additions}</span>
          <span class="shrink-0 tabular-nums text-(--solus-stop-bg)">−{part.deletions}</span>
        </div>
      {/each}
      <DropdownMenu.Separator />
    {/if}

    {#if files.length === 0}
      <div class="px-2.5 py-1.5 text-(--solus-text-tertiary)">
        No changes in this {scopeLabel}
      </div>
    {:else}
      <div class="max-h-72 overflow-y-auto">
        {#each files as file (file.path)}
          <DropdownMenu.Item onSelect={() => onOpenFile(file.path)}>
            <!-- The filename leads and the directory trails it, so a path too
                 long for the menu gives up its directory first. The filename
                 is what identifies the row. -->
            <span class="min-w-0 flex-1 truncate" title={file.displayPath}>
              <span class="text-(--solus-text-primary)">{file.name}</span>
              <span class="ml-1.5 text-(--solus-text-tertiary)">{file.dir}</span>
            </span>
            <span class="shrink-0 tabular-nums text-(--solus-art-3)">+{file.additions}</span>
            <span class="shrink-0 tabular-nums text-(--solus-stop-bg)">−{file.deletions}</span>
          </DropdownMenu.Item>
        {/each}
      </div>
    {/if}

    <DropdownMenu.Separator />
    <div class="flex items-center gap-1.5 px-2.5 pt-0.5 pb-1.5 text-(--solus-text-tertiary)">
      <span class="shrink-0">Compared against</span>
      <MiddleTruncate value={baseLabel} class="text-(--solus-text-secondary)" />
    </div>
  </DropdownMenu.Content>
</DropdownMenu.Root>
