<script lang="ts">
  import { FolderIcon, TrashIcon, CheckIcon, XIcon } from "phosphor-svelte";
  import { untrack } from "svelte";
  import type { ProjectEntry } from "../../../shared/types";
  import { projectsStore } from "../../contexts/projects.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import ProjectConfigEditor from "./ProjectConfigEditor.svelte";

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

<div class="flex min-h-[18rem] gap-5">
  <nav class="flex flex-col gap-0.5 w-60 shrink-0 border-r border-r-(--solus-container-border)/50 pr-3" aria-label="Projects">
    {#if loaded && projects.length === 0}
      <p class="text-[0.75rem] text-(--solus-text-tertiary) py-2">No projects yet. Open a folder to get started.</p>
    {/if}
    {#each projects as project (project.path)}
      <div class="group flex items-center gap-1 w-full rounded-lg min-w-0 [transition:background_0.15s_ease,color_0.15s_ease]
        {selected === project.path
          ? 'bg-(--solus-accent)/14 text-(--solus-text-primary)'
          : 'text-(--solus-text-secondary) hover:bg-(--solus-surface-hover)'}">
        <button
          type="button"
          class="flex items-center gap-2.5 flex-1 min-w-0 text-left py-2 px-2.5 border-none bg-transparent text-inherit cursor-pointer"
          aria-current={selected === project.path}
          onclick={() => (selected = project.path)}
        >
          <FolderIcon size={15} weight={selected === project.path ? "fill" : "regular"} class="shrink-0 {selected === project.path ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}" />
          <span class="flex flex-col min-w-0 gap-px">
            <span class="text-[0.8125rem] font-medium whitespace-nowrap overflow-hidden text-ellipsis">{project.folderName || folderName(project.path)}</span>
            <span class="text-[0.625rem] text-(--solus-text-tertiary) whitespace-nowrap overflow-hidden text-ellipsis">{project.path}</span>
          </span>
        </button>

        {#if confirming === project.path}
          <span class="inline-flex items-center gap-0.5 mr-1" role="group" aria-label="Confirm remove project">
            <button type="button" class="inline-flex items-center justify-center w-7 h-7 shrink-0 border-none rounded-[0.4375rem] bg-transparent text-(--solus-text-tertiary) cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:text-(--solus-status-error) hover:bg-(--solus-status-error)/12" aria-label="Confirm remove" onclick={() => remove(project.path)}>
              <CheckIcon size={13} />
            </button>
            <button type="button" class="inline-flex items-center justify-center w-7 h-7 shrink-0 border-none rounded-[0.4375rem] bg-transparent text-(--solus-text-tertiary) cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover)" aria-label="Cancel remove" onclick={() => (confirming = null)}>
              <XIcon size={13} />
            </button>
          </span>
        {:else}
          <button
            type="button"
            class="inline-flex items-center justify-center w-7 h-7 shrink-0 border-none rounded-[0.4375rem] bg-transparent text-(--solus-text-tertiary) cursor-pointer mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [transition:background_0.15s_ease,color_0.15s_ease,opacity_0.15s_ease] hover:text-(--solus-status-error) hover:bg-(--solus-status-error)/12
              {selected === project.path ? '!opacity-100' : ''}"
            aria-label="Remove {project.folderName || folderName(project.path)}"
            onclick={() => (confirming = project.path)}
          >
            <TrashIcon size={14} />
          </button>
        {/if}
      </div>
    {/each}
  </nav>

  <div class="flex-1 min-w-0">
    {#if selected}
      {#key selected}
        <ProjectConfigEditor cwd={selected} />
      {/key}
    {:else if loaded}
      <p class="text-[0.75rem] text-(--solus-text-tertiary) py-2">Select a project to edit its settings.</p>
    {/if}
  </div>
</div>
