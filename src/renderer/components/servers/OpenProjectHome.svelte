<script lang="ts">
  import {
    CircleNotchIcon,
    DownloadSimpleIcon,
    FolderIcon,
    GithubLogoIcon,
    LinkSimpleIcon,
    MagnifyingGlassIcon,
  } from "phosphor-svelte";
  import { Input } from "../ui/input";
  import { abbreviateHome } from "../../lib/paths";
  import type { OpenProjectStore } from "./open-project.store.svelte";
  import type { HomeRow } from "./lib/open-project-home";

  interface Props {
    store: OpenProjectStore;
    /** Built by the dialog, which owns ↑↓ over the same array. */
    rows: HomeRow[];
    highlightedIndex: number;
    onHighlight: (index: number) => void;
    onActivate: (index: number) => void;
    inputEl?: HTMLInputElement | HTMLTextAreaElement | null;
  }

  let {
    store,
    rows,
    highlightedIndex,
    onHighlight,
    onActivate,
    inputEl = $bindable(null),
  }: Props = $props();

  const recentRows = $derived(rows.filter((row) => row.kind === "recent"));
  /** Where the recents end — the divider and the action group start there. */
  const firstActionIndex = $derived(rows.findIndex((row) => row.kind === "action"));

  const ACTION_LABELS = {
    browse: "Open a folder…",
    github: "Clone from GitHub…",
    "clone-url": "Clone from a URL…",
  } satisfies Record<"browse" | "github" | "clone-url", string>;
  const ACTION_ICONS = {
    browse: FolderIcon,
    github: GithubLogoIcon,
    "clone-url": LinkSimpleIcon,
  };

</script>

{#snippet shell(index: number, height: string, children: import("svelte").Snippet)}
  {@const selected = index === highlightedIndex}
  <button
    type="button"
    role="option"
    aria-selected={selected}
    tabindex={-1}
    class="text-xs flex w-full items-center gap-3 rounded-lg px-2.5 text-left {height}
      [transition:background-color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
      {selected ? 'bg-muted' : 'hover:bg-muted'}"
    onmousemove={() => !selected && onHighlight(index)}
    onclick={() => onActivate(index)}
  >
    {@render children()}
  </button>
{/snippet}

<div class="text-xs px-3 pb-3">
  <!-- One box for both questions home answers: which project, or which repo. -->
  <label class="mb-1 flex h-[2.125rem] items-center gap-2 rounded-lg bg-muted px-2.5">
    <MagnifyingGlassIcon size={13} class="shrink-0 text-muted-foreground" />
    <Input
      bind:ref={inputEl}
      bind:value={store.homeQuery}
      class="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm text-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
      placeholder="Search projects or paste a repository URL"
      spellcheck={false}
      autocomplete="off"
      autocapitalize="off"
      dictation={false}
      role="combobox"
      aria-label="Search projects"
      aria-expanded={rows.length > 0}
      aria-controls="open-project-list"
    />
  </label>

  <div id="open-project-list" role="listbox" aria-label="Projects and actions">
    {#each rows as row, index (row.key)}
      {#if row.kind === "clone"}
        {#snippet cloneRow()}
          <DownloadSimpleIcon size={13} class="shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-sm">Clone {row.repoName}</span>
          <span class="shrink-0  text-muted-foreground">
            onto {store.hostLabel || "this machine"}
          </span>
        {/snippet}
        {@render shell(index, "h-10", cloneRow)}
      {:else if row.kind === "recent"}
        {#if index === 0 || rows[index - 1].kind !== "recent"}
          <div class="px-2.5 pb-1 pt-2  font-medium text-muted-foreground">Recent</div>
        {/if}
        {#snippet recentRow()}
          <FolderIcon size={13} class="shrink-0 text-muted-foreground opacity-80" />
          <span class="min-w-0 flex-1 truncate text-sm">{row.project.folderName}</span>
          <span
            class="max-w-[16.25rem] shrink-0 truncate font-mono  text-muted-foreground"
            title={row.project.path}
          >
            {abbreviateHome(row.project.path)}
          </span>
        {/snippet}
        {@render shell(index, "h-10", recentRow)}
      {:else}
        {#if index === firstActionIndex}
          {#if store.recentsLoading && recentRows.length === 0}
            <div class="flex items-center gap-2 px-2.5 pb-5 pt-6  text-muted-foreground">
              <CircleNotchIcon size={13} class="animate-spin" />
              Looking for projects on {store.hostLabel || "this machine"}…
            </div>
          {:else if recentRows.length === 0}
            <div class="flex flex-col items-center gap-1 px-6 pb-[1.375rem] pt-[1.625rem] text-center">
              {#if store.homeQuery.trim()}
                <div class="text-sm font-medium">Nothing matches “{store.homeQuery.trim()}”</div>
                <div class="text-muted-foreground">
                  Browse the filesystem or clone the repository instead.
                </div>
              {:else}
                <div class="text-sm font-medium">No projects on {store.hostLabel || "this machine"} yet</div>
                <div class="text-muted-foreground">Start with a folder or a repository.</div>
              {/if}
            </div>
          {/if}
          <div class="mt-2 border-t border-border pt-2"></div>
        {/if}
        {#snippet actionRow()}
          {@const Icon = ACTION_ICONS[row.action]}
          <Icon size={13} weight={row.action === "github" ? "fill" : "regular"} class="shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-sm">{ACTION_LABELS[row.action]}</span>
          {#if row.action === "browse"}
            <span class="shrink-0  text-muted-foreground">⌘O</span>
          {:else if row.action === "github" && store.readiness?.github?.solusLogin}
            <span class="shrink-0 truncate  text-muted-foreground">
              {store.readiness?.github?.solusLogin}
            </span>
          {/if}
        {/snippet}
        {@render shell(index, "h-[2.375rem]", actionRow)}
      {/if}
    {/each}
  </div>
</div>
