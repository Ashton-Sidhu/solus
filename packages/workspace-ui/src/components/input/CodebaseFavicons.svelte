<script lang="ts">
  /** The favicons of the folders of a codebase, as one small overlapping
   *  stack, in place of a generic icon (docs/plans/codebases.md §9). The
   *  caller gives at most three places (`codebaseFavicons`). A codebase with
   *  no folder on a host of this client shows the codebase icon. */
  import { FolderGit2 as CodebaseIcon } from "@lucide/svelte";
  import type { Place } from "@solus/contracts/types";
  import { projectsStore } from "../../contexts";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";

  let { places, size = 13 }: { places: readonly Place[]; size?: 13 | 16 } = $props();
</script>

{#if places.length === 0}
  <CodebaseIcon {size} class="shrink-0 text-(--solus-text-tertiary)" />
{:else}
  <span class="flex shrink-0 items-center -space-x-1" aria-hidden="true">
    {#each places as place (`${place.serverId}\n${place.path}`)}
      <span class="flex rounded-[4px] bg-(--solus-menu-bg) ring-1 ring-(--solus-menu-bg)">
        <ProjectFavicon
          projectKey={projectsStore.projectKeyFor(place.serverId, place.path)}
          class={size === 16 ? "size-4" : "size-[13px]"}
        />
      </span>
    {/each}
  </span>
{/if}
