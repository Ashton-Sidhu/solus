<script lang="ts">
  import { FolderIcon, TrashIcon, CheckIcon, XIcon } from "phosphor-svelte";
  import { untrack } from "svelte";
  import type { ProjectEntry } from "../../../shared/types";
  import { projectsStore, getWorkspaceContext } from "../../contexts";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";

  const session = getWorkspaceContext();
  const projectMetadata = projectsStore;

  let selected = $state<string | null>(null);
  let confirming = $state<string | null>(null);

  function folderName(path: string): string {
    const dir = path.replace(/\/$/, "");
    const parts = dir.split("/");
    return parts[parts.length - 1] || dir;
  }

  function withPresetProject(list: ProjectEntry[], preset: string | null | undefined): ProjectEntry[] {
    if (!preset || list.some((p) => p.path === preset)) return list;
    return [{ key: "", path: preset, folderName: folderName(preset), addedAt: "" }, ...list];
  }

  const projects = $derived(withPresetProject(projectMetadata.projects, session.settingsProjectCwd));
  const loaded = $derived(projectMetadata.projectsLoaded);

  async function refresh(preferred?: string | null) {
    const list = await projectMetadata.loadProjects({ force: true });
    const preset = preferred ?? session.settingsProjectCwd;
    selected = preset ?? withPresetProject(list, preset)[0]?.path ?? null;
  }

  $effect(() => {
    // Re-read whenever the deep-linked project changes (e.g. opened via the panel gear).
    const preset = session.settingsProjectCwd;
    untrack(() => {
      void refresh(preset);
    });
  });

  async function remove(path: string) {
    await projectMetadata.deleteProject(path).catch(() => {});
    confirming = null;
    const nextSelect = selected === path ? null : selected;
    await refresh(nextSelect);
  }
</script>

<SettingsSection>
<div class="flex min-h-[18rem] gap-4 p-3">
  <nav class="flex flex-col gap-0.5 w-60 shrink-0 border-r border-r-border pr-3" aria-label="Projects">
    {#if loaded && projects.length === 0}
      <p class="text-[0.75rem] text-(--solus-text-tertiary) py-2">No projects yet. Open a folder to get started.</p>
    {/if}
    {#each projects as project (project.path)}
      {@const active = selected === project.path}
      <div class="group flex items-center gap-1 w-full rounded-md border min-w-0 [transition:background_0.15s_ease,color_0.15s_ease,border-color_0.15s_ease]
        {active
          ? 'border-(--solus-accent)/25 bg-(--solus-accent)/10 text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-muted'}">
        <button
          type="button"
          class="flex items-center gap-2.5 flex-1 min-w-0 text-left py-2 px-2.5 border-none bg-transparent text-inherit cursor-pointer"
          aria-current={active}
          onclick={() => (selected = project.path)}
        >
          <FolderIcon size={15} weight={active ? "fill" : "regular"} class="shrink-0 {active ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}" />
          <span class="flex flex-col min-w-0 gap-px">
            <span class="text-[0.8125rem] {active ? 'font-medium' : 'font-normal'} whitespace-nowrap overflow-hidden text-ellipsis">{project.folderName || folderName(project.path)}</span>
            <span class="text-[0.625rem] text-(--solus-text-tertiary) whitespace-nowrap overflow-hidden text-ellipsis">{project.path}</span>
          </span>
        </button>

        {#if confirming === project.path}
          <span class="inline-flex items-center gap-0.5 mr-1" role="group" aria-label="Confirm remove project">
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-(--solus-text-tertiary) hover:text-(--solus-status-error) hover:bg-(--solus-status-error)/12"
              aria-label="Confirm remove"
              onclick={() => remove(project.path)}
            >
              <CheckIcon size={13} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-(--solus-text-tertiary)"
              aria-label="Cancel remove"
              onclick={() => (confirming = null)}
            >
              <XIcon size={13} />
            </Button>
          </span>
        {:else}
          <Button
            variant="ghost"
            size="icon-sm"
            class="mr-1 text-(--solus-text-tertiary) hover:text-(--solus-status-error) hover:bg-(--solus-status-error)/12 opacity-0 group-hover:opacity-100 focus-visible:opacity-100
              {selected === project.path ? '!opacity-100' : ''}"
            aria-label="Remove {project.folderName || folderName(project.path)}"
            onclick={() => (confirming = project.path)}
          >
            <TrashIcon size={14} />
          </Button>
        {/if}
      </div>
    {/each}
  </nav>

  <div class="flex-1 min-w-0">
    {#if !selected && loaded}
      <p class="text-[0.75rem] text-(--solus-text-tertiary) py-2">Select a project to edit its settings.</p>
    {/if}
  </div>
</div>
</SettingsSection>
