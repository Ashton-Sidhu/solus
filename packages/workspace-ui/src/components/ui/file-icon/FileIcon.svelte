<script module lang="ts">
  import type { resolveFileIcon as ResolveFileIcon } from "@solus/client-core/file-icons";

  // The icon set (@pierre/trees and its sprite) loads beside the workspace,
  // not in its first chunks. Until it runs, an icon keeps its box and is empty.
  let resolveIcon = $state<typeof ResolveFileIcon | null>(null);
  void import("@solus/client-core/file-icons").then((module) => (resolveIcon = module.resolveFileIcon));
</script>

<script lang="ts">
  let { path, size = 14, class: className = "" }: {
    path: string;
    size?: number;
    class?: string;
  } = $props();
</script>

<!-- The resolver returns only trusted package SVG and static local symbols. -->
<span class="inline-flex shrink-0 items-center justify-center [&>svg]:size-full {className}" style:width="{size}px" style:height="{size}px" aria-hidden="true">
  {#if resolveIcon}
    {@html resolveIcon(path).svg}
  {/if}
</span>
