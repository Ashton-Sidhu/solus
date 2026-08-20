<script lang="ts">
  import { Skeleton } from "../ui/skeleton";
  import FilesPaneSkeleton from "./FilesPaneSkeleton.svelte";

  interface Props {
    variant: "tree" | "editor";
  }

  let { variant }: Props = $props();
</script>

<!-- The complete files-route frame. Both the route outlet and the route host
     use it, so resolving either lazy module keeps one continuous skeleton. -->
<div
  class="flex h-full min-h-0 w-full flex-col bg-(--solus-container-bg)"
  role="status"
  aria-label={variant === "tree" ? "Loading files" : "Loading file"}
>
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--solus-container-border)_50%,transparent)] pr-[max(0.75rem,var(--solus-pane-chrome-inset,0px))] pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
    aria-hidden="true"
  >
    <Skeleton class="size-3.5 shrink-0 rounded-[0.1875rem]" />
    <Skeleton class="h-2.5 w-28 rounded-[0.1875rem]" />
  </div>
  <div class="flex min-h-0 flex-1 flex-col" aria-hidden="true">
    <FilesPaneSkeleton {variant} />
  </div>
</div>
