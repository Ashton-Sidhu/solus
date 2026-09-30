<script lang="ts">
  import Icon from "@iconify/svelte";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../diagram/iconify";
  import { extensionLabel } from "./lib/diff-file-path";

  // Register the small offline icon subset used by file-type badges.
  ensureIconCollections();

  /** A brand icon for a known language; a monochrome extension chip otherwise. */
  let { path }: { path: string } = $props();

  const icon = $derived(fileTypeIcon(path));
</script>

{#if icon}
  <Icon {icon} width="14" height="14" class="shrink-0 text-xs" />
{:else}
  <span
    class="shrink-0 rounded bg-(--solus-accent-light) px-1.5 py-0.5 font-mono text-xs font-medium text-(--solus-text-tertiary)"
  >
    {extensionLabel(path)}
  </span>
{/if}
