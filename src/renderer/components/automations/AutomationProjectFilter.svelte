<script lang="ts">
  import { CaretDownIcon, FolderIcon } from "phosphor-svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { abbreviateHome } from "../../lib/paths";
  import type { AutomationProject } from "./lib/automation-projects";

  interface Props {
    projects: AutomationProject[];
    value: string | null;
    allCount: number;
    onSelect: (projectKey: string | null) => void;
  }

  let { projects, value, allCount, onSelect }: Props = $props();
  let open = $state(false);
  const active = $derived(
    projects.find((project) => project.key === value) ?? null,
  );
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="flex h-7 max-w-[12rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 px-2.5 text-sm transition-colors duration-150 {active
          ? 'bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
          : 'bg-transparent text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]'}"
        aria-label="Filter by project"
      >
        <FolderIcon size={13} class="shrink-0 opacity-75" />
        <span class="truncate">{active?.label ?? "All projects"}</span>
        <CaretDownIcon size={9} class="shrink-0 opacity-60" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[17.625rem]">
    <DropdownMenu.RadioGroup
      value={active?.key ?? "all"}
      onValueChange={(projectKey) => {
        open = false;
        onSelect(projectKey === "all" ? null : projectKey);
      }}
    >
      <DropdownMenu.GroupHeading>Projects</DropdownMenu.GroupHeading>
      <DropdownMenu.RadioItem value="all">
        <FolderIcon size={14} class="shrink-0" />
        <span class="min-w-0 flex-1 truncate">All projects</span>
        <span class="text-xs tabular-nums text-muted-foreground opacity-60">
          {allCount}
        </span>
      </DropdownMenu.RadioItem>
      {#if projects.length > 0}<DropdownMenu.Separator />{/if}
      {#each projects as project (project.key)}
        <DropdownMenu.RadioItem
          value={project.key}
          title={abbreviateHome(project.projectPath)}
        >
          <ProjectFavicon projectRoot={project.projectPath} class="size-3.5" />
          <span class="min-w-0 flex-1 truncate">{project.label}</span>
          <span class="text-xs tabular-nums text-muted-foreground opacity-60">
            {project.count}
          </span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
