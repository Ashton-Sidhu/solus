<script lang="ts">
  import { resolveFileIcon } from "@solus/client-core/file-icons";

  let { path, size = 14, class: className = "" }: {
    path: string;
    size?: number;
    class?: string;
  } = $props();
</script>

<!-- The resolver returns only trusted package SVG and static local symbols. -->
<span class="inline-flex shrink-0 items-center justify-center [&>svg]:size-full {className}" style:width="{size}px" style:height="{size}px" aria-hidden="true">
  {@html resolveFileIcon(path).svg}
</span>
