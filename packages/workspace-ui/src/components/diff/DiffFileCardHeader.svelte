<script lang="ts">
  import type { Snippet } from "svelte";
  import DiffFileTypeBadge from "./DiffFileTypeBadge.svelte";
  import { dirName, fileName } from "./lib/diff-file-path";

  /**
   * The header row of a diff card: a disclosure caret, the file-type badge,
   * and the path with the folder muted and the name emphasized — the same
   * header the diff stream draws. The review guide and the Insights result
   * both use it. `trailing` holds the card's own actions or figures.
   */
  interface Props {
    path: string;
    open: boolean;
    onToggle: () => void;
    trailing?: Snippet;
  }

  let { path, open, onToggle, trailing }: Props = $props();
</script>

<div class="flex items-center gap-2 border-(--solus-art-border) px-3 py-2.5" class:border-b={open}>
  <!-- The card's own header row, not a button primitive. -->
  <button
    type="button"
    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden text-left text-chrome-shelf"
    aria-expanded={open}
    aria-label={open ? `Collapse diff for ${fileName(path)}` : `Expand diff for ${fileName(path)}`}
    onclick={onToggle}
  >
    <span
      class="inline-block size-1.5 shrink-0 border-r-[1.5px] border-b-[1.5px] border-current text-(--solus-text-tertiary) transition-transform duration-150 {open
        ? 'rotate-[225deg]'
        : 'rotate-45'}"
    ></span>
    <DiffFileTypeBadge {path} />
    <span class="min-w-0 flex-1 truncate font-mono">
      <span class="text-(--solus-text-tertiary)">{dirName(path)}</span>
      <span class="text-(--solus-text-primary)">{fileName(path)}</span>
    </span>
  </button>
  {@render trailing?.()}
</div>
