<script lang="ts">
  /**
   * Pick your projects (docs/plans/one-page-onboarding.md decision 6): the
   * folders the person used with Claude Code and Codex on this host, newest
   * first, with the recent ones checked. "Open another folder" stays.
   */
  import { onMount } from "svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { Button } from "../ui/button";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import { abbreviateHome } from "../../lib/paths";
  import { agentHistoryStore as history } from "./agent-history.store.svelte";
  import { ageLabel, historyRows, VISIBLE_PROJECT_ROWS } from "./lib/onboarding-model";
  import { onboardingStore as store } from "./onboarding.store.svelte";

  let { machineNoun }: { machineNoun: string } = $props();

  let showsAll = $state(false);
  let pickerOpen = $state(false);
  const now = Date.now();

  const rows = $derived([
    ...historyRows(history.projects ?? []).map((project) => ({
      path: project.path,
      name: project.name,
      trailing: `${abbreviateHome(project.path)} · ${ageLabel(project.lastUsedAt, now)}`,
      isProject: project.isProject,
    })),
    ...store.otherFolders.map((path) => ({
      path,
      name: path.split("/").filter(Boolean).at(-1) ?? path,
      trailing: abbreviateHome(path),
      isProject: false,
    })),
  ]);
  const shown = $derived(showsAll ? rows : rows.slice(0, VISIBLE_PROJECT_ROWS));
  const hiddenCount = $derived(rows.length - shown.length);

  onMount(() => void store.loadProjects());
</script>

{#snippet checkbox(isChecked: boolean)}
  {#if isChecked}
    <span class="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-(--solus-text-primary)" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="var(--background)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </span>
  {:else}
    <span class="size-4 shrink-0 rounded-[4px] border-[1.5px] border-border" aria-hidden="true"></span>
  {/if}
{/snippet}

{#if history.projects === null && history.isLoading}
  <div class="flex flex-col" aria-label="Reading your agent history">
    {#each [0, 1, 2] as index (index)}
      <div class="flex h-10 items-center gap-3.5">
        <span class="size-4 shrink-0 rounded-[4px] bg-(--wash-2)"></span>
        <span class="h-2.5 w-32 rounded-full bg-(--wash-2)"></span>
      </div>
    {/each}
  </div>
{:else if history.error && history.projects === null}
  <div class="flex min-h-10 items-center gap-3.5">
    <p class="m-0 min-w-0 flex-1 text-[13px] leading-4.5 text-(--solus-status-error)" role="alert">Could not read your agent history: {history.error}</p>
    <Button variant="outline" size="sm" class="h-7.5 rounded-md px-3 text-[13px]" onclick={() => void store.loadProjects()}>Try again</Button>
  </div>
{:else if rows.length === 0}
  <p class="m-0 py-2 text-[13px] leading-4.5 text-(--solus-text-tertiary)">No Claude Code or Codex history on this {machineNoun} yet.</p>
{/if}

{#if rows.length > 0}
  <div class="flex flex-col" role="group" aria-label="Projects to add" aria-busy={history.isLoading}>
    {#each shown as row (row.path)}
      {@const isChecked = row.isProject || store.checkedProjects.has(row.path)}
      <button
        type="button"
        role="checkbox"
        aria-checked={isChecked}
        disabled={row.isProject}
        title={row.isProject ? "Already a project" : undefined}
        class="flex h-10 w-full min-w-0 shrink-0 items-center gap-3.5 overflow-hidden rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
        onclick={() => store.toggleProject(row.path)}
      >
        {@render checkbox(isChecked)}
        <span
          class="min-w-0 flex-1 truncate text-[14px] leading-5"
          class:font-medium={isChecked}
          class:text-(--solus-text-primary)={isChecked}
          class:text-(--solus-text-secondary)={!isChecked}
        >{row.name}</span>
        <span class="max-w-[50%] shrink-0 truncate font-mono text-[12px] leading-4 text-(--solus-text-tertiary)">{row.isProject ? "Already a project" : row.trailing}</span>
      </button>
    {/each}
  </div>
{/if}

<div class="flex h-10 items-center gap-3 pl-7.5 text-[13px] leading-4.5 font-medium text-(--solus-text-secondary)">
  {#if hiddenCount > 0}
    <button type="button" class="rounded-sm hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring" onclick={() => (showsAll = true)}>Show {hiddenCount} more</button>
    <span class="text-border" aria-hidden="true">·</span>
  {/if}
  <button
    type="button"
    class="rounded-sm hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
    disabled={!store.serverId}
    onclick={() => (pickerOpen = true)}
  >Open another folder</button>
</div>

{#if store.serverId}
  <DirectoryPicker
    bind:open={pickerOpen}
    onClose={() => (pickerOpen = false)}
    onSelect={(path) => {
      pickerOpen = false;
      store.addOtherFolder(path);
    }}
    title="Open a folder"
    actionLabel="Add"
    api={serverConnections.apiFor(store.serverId)}
    serverId={store.serverId}
  />
{/if}
