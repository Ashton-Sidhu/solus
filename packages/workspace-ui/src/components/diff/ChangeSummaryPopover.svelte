<script lang="ts">
  import { GitBranch as GitBranchIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
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

<button
  bind:this={triggerEl}
  type="button"
  class="no-drag flex h-[1.625rem] min-w-0 shrink cursor-pointer items-center gap-2 overflow-hidden rounded-full border-0 px-2.5 text-chrome-dense transition-[background-color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 {open
    ? 'bg-[var(--wash-2)]'
    : 'bg-transparent hover:bg-[var(--wash-2)]'}"
  aria-haspopup="menu"
  aria-expanded={open}
  aria-label={`${branchLabel}: ${additions} additions, ${deletions} deletions. Show changed files`}
  title={branchTitle ?? branchLabel}
  onclick={() => (open = !open)}
>
  <GitBranchIcon size={12} class="shrink-0 text-muted-foreground" />
  <!-- The last thing to give, and the only thing that does: below a phone-width
       panel the two counts and the glyph carry the summary on their own. -->
  <span class="truncate font-medium @max-[30rem]/band:hidden">{branchLabel}</span>
  <span class="shrink-0 font-mono tabular-nums text-(--solus-art-3)">+{additions}</span>
  <span class="shrink-0 font-mono tabular-nums text-(--solus-stop-bg)">−{deletions}</span>
</button>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[min(19rem,calc(100vw-2rem))]"
  >
    <DropdownMenu.Label>Changed files · {scopeLabel}</DropdownMenu.Label>

    {#if files.length === 0}
      <div class="px-2 py-1.5 text-chrome-dense text-muted-foreground">
        No changes in this {scopeLabel}
      </div>
    {:else}
      <div class="max-h-72 overflow-y-auto">
        {#each files as file (file.path)}
          <DropdownMenu.Item onSelect={() => onOpenFile(file.path)}>
            <!-- The directory gives; the filename never does. It is what
                 identifies the row, so it is the one part that must survive a
                 path too long for the menu. -->
            <span class="flex min-w-0 flex-1 font-mono text-chrome-dense" title={file.displayPath}>
              <span class="truncate text-muted-foreground">{file.dir}</span>
              <span class="shrink-0">{file.name}</span>
            </span>
            <span class="shrink-0 font-mono tabular-nums text-(--solus-art-3)">+{file.additions}</span>
            <span class="shrink-0 font-mono tabular-nums text-(--solus-stop-bg)">−{file.deletions}</span>
          </DropdownMenu.Item>
        {/each}
      </div>
    {/if}

    <div
      class="mt-1 flex items-center gap-2 border-t border-(--hairline) px-2 pt-2 pb-1 text-chrome-dense text-muted-foreground"
    >
      <span>compared against</span>
      <span class="min-w-0 truncate font-mono text-foreground">{baseLabel}</span>
    </div>
  </DropdownMenu.Content>
</DropdownMenu.Root>
