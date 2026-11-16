<script lang="ts">
  import {
    CircleArrowDown as DownloadsIcon,
    FileText as DocumentsIcon,
    Folder as FolderIcon,
    FolderCode as ProjectsIcon,
    HardDrive as RootIcon,
    House as HouseIcon,
    Monitor as DesktopIcon,
  } from "@lucide/svelte";
  import type { Place, PlaceIcon } from "./lib/picker-places";

  interface Props {
    locations: Place[];
    /** Recent projects on the browsed host, already in its path form. */
    recents: Array<{ label: string; path: string }>;
    /** The typed path; the place it equals reads as current. */
    activePath: string;
    onNavigate: (path: string) => void;
  }

  let { locations, recents, activePath, onNavigate }: Props = $props();
</script>

<!-- The sidebar of a file manager: fixed places on top, recent projects under
     them, each group under its own heading. It is the one tinted surface of
     the dialog, an inset panel, so no rule is necessary between it and the list. -->
<nav
  class="m-2 flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-xl bg-[var(--wash-1)] p-2"
  aria-label="Places"
>
  {#snippet heading(label: string)}
    <span class="flex h-8 shrink-0 items-center px-2.5 text-xs text-muted-foreground select-none">{label}</span>
  {/snippet}

  {#snippet place(label: string, target: string, icon: PlaceIcon)}
    <button
      type="button"
      class="flex h-8 w-full shrink-0 items-center gap-3 rounded-lg px-2.5 text-left text-[0.8125rem] outline-none
        [transition:background-color_var(--duration-quick)_var(--ease-premium),color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
        focus-visible:ring-2 focus-visible:ring-(--solus-accent)
        {activePath === target ? 'bg-[var(--wash-3)] font-medium' : 'hover:bg-[var(--wash-2)]'}"
      onclick={() => onNavigate(target)}
      title={target}
    >
      <span class="shrink-0 {activePath === target ? 'text-primary' : 'text-muted-foreground'}">
        {#if icon === "home"}
          <HouseIcon size={16} />
        {:else if icon === "projects"}
          <ProjectsIcon size={16} />
        {:else if icon === "root"}
          <RootIcon size={16} />
        {:else if icon === "desktop"}
          <DesktopIcon size={16} />
        {:else if icon === "documents"}
          <DocumentsIcon size={16} />
        {:else if icon === "downloads"}
          <DownloadsIcon size={16} />
        {:else}
          <FolderIcon size={16} />
        {/if}
      </span>
      <span class="truncate">{label}</span>
    </button>
  {/snippet}

  {@render heading("Places")}
  {#each locations as loc (loc.path)}
    {@render place(loc.label, loc.path, loc.icon)}
  {/each}

  {#if recents.length > 0}
    <div class="h-4 shrink-0"></div>
    {@render heading("Recent projects")}
    {#each recents as recent (recent.path)}
      {@render place(recent.label, recent.path, "folder")}
    {/each}
  {/if}
</nav>
