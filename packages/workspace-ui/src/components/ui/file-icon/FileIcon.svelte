<script module lang="ts">
  import type { resolveFileIcon as ResolveFileIcon } from "@solus/client-core/file-icons";

  // The icon set (@pierre/trees and its sprite) loads beside the workspace,
  // not in its first chunks. Until it runs, an icon keeps its box and is empty.
  let resolveIcon = $state<typeof ResolveFileIcon | null>(null);
  void import("@solus/client-core/file-icons").then((module) => (resolveIcon = module.resolveFileIcon));
</script>

<script lang="ts">
  let { path, size = 14, class: className = "", specificOnly = false }: {
    path: string;
    size?: number;
    class?: string;
    /** Show nothing when the path has no icon of its own, only the generic file. */
    specificOnly?: boolean;
  } = $props();

  const icon = $derived(resolveIcon?.(path));
</script>

<!-- The resolver returns only trusted package SVG and static local symbols. -->
{#if !(specificOnly && icon?.token === "default")}
<span class="inline-flex shrink-0 items-center justify-center [&>svg]:size-full {className}" style:width="{size}px" style:height="{size}px" aria-hidden="true">
  {#if icon}
    {@html icon.svg}
  {/if}
</span>
{/if}
