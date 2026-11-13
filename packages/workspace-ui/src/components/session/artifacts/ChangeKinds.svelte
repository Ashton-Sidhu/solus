<script lang="ts">
  import type { ChangeKind } from "@solus/client-core/change-breakdown";
  import type { ChangeKindShare } from "./lib/change-kinds";

  /**
   * The kinds of a change, over the Changes card's tree: a thin line that
   * shows each kind's part of the change, and a chip for each kind under it.
   * Selecting a chip shows only that kind in the tree: the chip takes a blue
   * tint, and the other parts of the line fade. Selecting it again shows every
   * kind.
   */
  interface Props {
    kinds: readonly ChangeKindShare[];
    /** The one kind the tree shows. Null shows every kind. */
    selected: ChangeKind | null;
    onSelect: (kind: ChangeKind | null) => void;
  }
  let { kinds, selected, onSelect }: Props = $props();

  // One colour family, blue, in steps a reader can tell apart side by side:
  // the deep blue, the sky, then lighter ones. Greys of one hue were too close,
  // and a hue for each kind was too loud.
  const SHARE_TONE = [
    "bg-(--solus-art-5)",
    "bg-(--solus-art-7)",
    "bg-[color-mix(in_oklab,var(--solus-art-5)_50%,transparent)]",
    "bg-[color-mix(in_oklab,var(--solus-art-7)_34%,transparent)]",
    "bg-[color-mix(in_oklab,var(--solus-art-5)_16%,transparent)]",
  ];

  function percent(share: number): string {
    return `${Math.max(1, Math.round(share * 100))}%`;
  }
</script>

<div class="px-2 pt-1 pb-2" data-testid="artifacts-change-kinds">
  <div class="flex h-1 gap-0.5" aria-hidden="true">
    {#each kinds as entry, index (entry.kind)}
      <span
        class="min-w-1.5 rounded-full transition-opacity duration-200 ease-(--ease-premium) motion-reduce:transition-none {SHARE_TONE[
          index
        ]} {selected !== null && selected !== entry.kind ? 'opacity-30' : ''}"
        style:width="{entry.share * 100}%"
      ></span>
    {/each}
  </div>
  <div class="mt-2 flex flex-wrap items-center gap-1">
    {#each kinds as entry, index (entry.kind)}
      {@const on = selected === entry.kind}
      <button
        type="button"
        aria-pressed={on}
        title="{entry.label}: {entry.fileCount} {entry.fileCount === 1 ? 'file' : 'files'}, {percent(entry.share)} of the change"
        class="flex h-6 cursor-pointer items-center gap-1.5 rounded-md border-0 px-2 text-xs transition-colors duration-(--duration-base) ease-(--ease-premium) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-9 {on
          ? 'bg-[color-mix(in_oklab,var(--solus-art-5)_11%,transparent)] text-[color-mix(in_oklab,var(--solus-art-5)_78%,var(--foreground))] shadow-[inset_0_0_0_.5px_color-mix(in_oklab,var(--solus-art-5)_38%,transparent)]'
          : 'bg-transparent text-(--solus-text-secondary) shadow-[inset_0_0_0_.5px_var(--hairline-strong)] hover:bg-[var(--wash-2)]'}"
        data-testid="artifacts-change-kind"
        data-kind={entry.kind}
        onclick={() => onSelect(on ? null : entry.kind)}
      >
        <span aria-hidden="true" class="h-2 w-[3px] rounded-full {SHARE_TONE[index]}"></span>
        {entry.label}
        <span class="tabular-nums opacity-60">{entry.fileCount}</span>
      </button>
    {/each}
  </div>
</div>
