<script lang="ts">
  import type { Snippet } from "svelte";

  /** One labelled action in a `ListBulkBar`. The caller passes the icon and label. */
  interface Props {
    title?: string;
    onclick: () => void;
    children: Snippet;
  }
  let { title, onclick, children }: Props = $props();
</script>

<button
  type="button"
  class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome"
  {title}
  {onclick}
>
  {@render children()}
</button>
