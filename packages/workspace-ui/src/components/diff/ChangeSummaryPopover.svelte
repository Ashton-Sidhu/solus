<script lang="ts">
  import { GitBranch as GitBranchIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as TooltipUI from "../ui/tooltip";
  import { MiddleTruncate } from "../ui/middle-truncate";
  import type { ChangedFileSummary } from "./lib/review-header";

  /**
   * What changed, and where the counts came from.
   *
   * The band shows a branch and two numbers; this is the list behind them. It
   * is a jump list, not a filter: a row scrolls the Diff view to that file. The
   * base ref lives in this footer rather than on the band, because "compared
   * against what" is asked once and then remembered.
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
  let triggerEl = $state<HTMLButtonElement | null>(null);
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
      <button
        {...tooltipProps}
        bind:this={triggerEl}
        type="button"
        class="no-drag flex h-[1.625rem] min-w-0 max-w-[28rem] shrink cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-0 px-2.5 text-workspace-chrome transition-[background-color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 {open
          ? 'bg-[var(--wash-2)]'
          : 'bg-transparent hover:bg-[var(--wash-2)]'}"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${branchLabel}: ${additions} additions, ${deletions} deletions. Show changed files`}
        onclick={() => (open = !open)}
      >
        <GitBranchIcon class="size-3 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
        <!-- The last thing to give, and the only thing that does: below a phone-width
             panel the two counts and the glyph carry the summary on their own. -->
        <MiddleTruncate
          value={branchLabel}
          showTitle={false}
          class="text-(--solus-text-primary) @max-[30rem]/band:hidden"
        />
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
