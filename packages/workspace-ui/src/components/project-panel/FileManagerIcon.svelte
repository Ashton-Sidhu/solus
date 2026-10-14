<script lang="ts">
  import { FolderClosed as FolderClosedIcon } from "@lucide/svelte";
  import type { FileManagerKind } from "@solus/contracts/types";
  import finderIcon from "../settings/app-icons/finder.png";

  interface Props {
    kind: FileManagerKind;
  }
  let { kind }: Props = $props();
</script>

<!-- Finder is its Dock icon (`bun run generate:app-icons`). Explorer is
     t3code's mark (MIT). Linux has no one file manager, so a folder stands
     in for whichever the desktop uses. -->
{#if kind === "finder"}
  <img src={finderIcon} alt="" class="size-4 shrink-0" />
{:else if kind === "file-explorer"}
  <svg viewBox="0 0 24 24" fill="none" class="size-4 shrink-0" aria-hidden="true">
    <path d="M2 5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" fill="#D99A16" />
    <path d="M2 9h20v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" fill="#FFCE45" />
    <path d="M8 14h8v7H8Z" fill="#58B8E8" />
    <path d="M10 16h4v2h-4Z" fill="#1879B9" />
  </svg>
{:else}
  <FolderClosedIcon class="size-4" />
{/if}
