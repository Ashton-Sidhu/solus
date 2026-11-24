<script lang="ts">
  import { Check as CheckIcon, Plus as PlusIcon, X as XIcon } from "@lucide/svelte";
  import { untrack, type Snippet } from "svelte";
  import { taskSourceProvider } from "@solus/contracts/task-sources";
  import { getSettingsContext, projectsStore, serversStore, taskHostId, taskSourcesStore } from "../../../contexts";
  import { Button } from "../../ui/button";
  import { SourceLogo } from "../../ui/list-page";
  import TaskSourceAdd from "./TaskSourceAdd.svelte";
  import {
    SOURCE_KIND_SHORT_NAMES,
    projectSourceRows,
    sourceStripRows,
    withTaskSource,
    withTaskSources,
    withoutTaskSource,
    type ProjectSourceRow,
  } from "./lib/task-source-setup";
  import { saveTaskSources } from "./lib/save-task-sources.svelte";

  /**
   * The Tasks page of a person setting up their first task sources
   * (docs/tasks.md), drawn in the list page's own group lines, over cards:
   * the repositories of their recent projects, the sources they added from a
   * provider's menu, and a button for each provider. Adding does not leave the
   * page, so they add as many as they like and take one back. "Add projects",
   * the page's own action, adds every project repository not added yet and
   * ends the setup.
   */
  interface Props {
    /** Called after the sources change, so the page reads their tasks. */
    onChanged: () => void;
    /** End the setup and show the tasks. */
    onDone: () => void;
  }
  let { onChanged, onDone }: Props = $props();

  const settings = getSettingsContext();
  const config = $derived({ taskSources: settings.taskSources });
  // The repositories of the projects on the task host, from the project list
  // the client holds already: they show at once, without waiting for GitHub,
  // Jira and Linear to list what else can be added.
  const hostId = $derived(taskHostId());
  const projectRows = $derived.by(() => {
    if (!hostId) return [];
    const identities = serversStore.projectIdentitiesFor(hostId);
    const projects = projectsStore.projectsFor(hostId).map((project) => ({
      repositoryKey: project.repositoryKey,
      lastUsedAt: project.lastUsedAt,
      originKey: identities.find((identity) => identity.path === project.path)?.repoKey ?? null,
    }));
    return projectSourceRows(projects, config.taskSources);
  });
  const notAddedProjects = $derived(projectRows.filter((row) => !row.isAdded));
  // The store keeps the list it last read, so the repositories show from that
  // copy at once. Only a host with no list yet holds their place with a card.
  const isReadingProjects = $derived(
    !!hostId && !projectsStore.projectsLoadedFor(hostId) && projectsStore.projectsFor(hostId).length === 0,
  );
  // What the person added from a provider's menu: every source that is not
  // one of the project rows, which say "Added" themselves.
  const otherAdded = $derived(
    sourceStripRows(config, taskSourcesStore.sources).filter(
      (row) => !projectRows.some((project) => project.sourceKey === row.sourceKey),
    ),
  );

  // The providers' choices are read as the setup opens, so a provider's menu
  // has them when the person opens it. Nothing on the page waits for them.
  $effect(() => {
    untrack(() => void taskSourcesStore.loadOptions());
  });

  function save(patch: Parameters<typeof saveTaskSources>[1]) {
    if (saveTaskSources(settings, patch)) onChanged();
  }

  // The page's action. With every project repository added already, it only
  // ends the setup.
  const hasSource = $derived(config.taskSources.length > 0);
  function addProjects() {
    if (notAddedProjects.length > 0) {
      save(withTaskSources(config, notAddedProjects.map((project) => project.source)));
    }
    onDone();
  }

  function toggle(row: ProjectSourceRow) {
    save(row.isAdded ? withoutTaskSource(config, row.sourceKey) : withTaskSource(config, row.source));
  }
</script>

{#snippet groupLine(label: string, count: number | null)}
  <!-- ListGroup's line. The label starts on the title's line and the rule runs
       to the cards' edge. -->
  <div class="flex h-[30px] items-center gap-2.5 pl-2.5">
    <span class="text-xs font-normal text-muted-foreground uppercase">{label}</span>
    {#if count !== null}
      <span class="text-xs tabular-nums text-muted-foreground opacity-70">{count}</span>
    {/if}
    <span class="h-px flex-1 bg-[var(--hairline)]"></span>
  </div>
{/snippet}

{#snippet card(provider: "github" | "jira" | "linear", label: string, detail: string, action: Snippet)}
  <!-- The setup's card, as the provider cards below: the ring is drawn inside
       the box, so the edge of the scrolling page cannot cut it off. -->
  <div class="flex min-w-0 items-center gap-3 overflow-hidden rounded-xl bg-card py-3 pr-3 pl-2.5 shadow-[inset_0_0_0_0.5px_var(--hairline-strong)]">
    <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--wash-2)]" aria-hidden="true">
      <SourceLogo source={provider} />
    </span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-workspace-chrome leading-5 font-medium text-foreground" title={label}>{label}</span>
      <span class="truncate text-xs leading-4 text-muted-foreground" title={detail}>{detail}</span>
    </span>
    {@render action()}
  </div>
{/snippet}

<div class="flex w-full flex-col gap-7 pt-1 pb-12">
  <!-- The action shows once the person has added a source. Until then it is
       invisible but keeps its place, so nothing moves when it shows. -->
  <div class="flex min-h-8 items-center gap-4 pl-2.5">
    <p class="m-0 min-w-0 flex-1 text-[13px] leading-[1.45] text-(--solus-text-secondary)">
      Add as many GitHub, Jira and Linear sources as you like. Their issues show up here, ready to hand to an agent.
    </p>
    <Button
      class="gap-[7px] px-[13px] text-workspace-chrome hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)] {hasSource ? '' : 'invisible'}"
      onclick={addProjects}
    >
      <PlusIcon class="size-4" />
      Add projects
    </Button>
  </div>

  {#if isReadingProjects || projectRows.length > 0}
    <section class="flex flex-col gap-1" aria-label="From your projects">
      {@render groupLine("From your projects", isReadingProjects ? null : projectRows.length)}
      <div class="grid grid-cols-1 gap-2 @min-[40rem]/pane:grid-cols-3">
        {#if isReadingProjects}
          <div class="flex items-center gap-3 rounded-xl bg-card py-3 pl-2.5 shadow-[inset_0_0_0_0.5px_var(--hairline-strong)]" aria-busy="true" aria-label="Reading your projects">
            <span class="size-8 shrink-0 rounded-lg bg-muted"></span>
            <span class="flex flex-1 flex-col gap-1.5">
              <span class="h-3.5 w-2/5 rounded bg-muted"></span>
              <span class="h-3 w-1/4 rounded bg-muted"></span>
            </span>
          </div>
        {:else}
          {#each projectRows as project (project.sourceKey)}
            <!-- The whole card adds its repository, as a provider card opens its
                 menu; added, it shows a check, and a second click takes it back. -->
            <button
              type="button"
              class="flex min-w-0 cursor-pointer items-center gap-3 overflow-hidden rounded-xl border-0 py-3 pr-3 pl-2.5 text-left shadow-[inset_0_0_0_0.5px_var(--hairline-strong)] transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {project.isAdded
                ? 'bg-[var(--wash-1)]'
                : 'bg-card'}"
              aria-pressed={project.isAdded}
              title={project.isAdded ? `Remove ${project.label}` : `Add ${project.label}`}
              onclick={() => toggle(project)}
            >
              <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--wash-2)]" aria-hidden="true">
                <SourceLogo source="github" />
              </span>
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-workspace-chrome leading-5 font-medium text-foreground">{project.label}</span>
                <span class="truncate text-xs leading-4 text-muted-foreground">
                  {project.isAdded ? "Added" : project.isFork ? "Repository · a fork, whose issues are rarely yours" : "Repository"}
                </span>
              </span>
              {#if project.isAdded}
                <CheckIcon size={16} class="shrink-0 text-(--solus-accent)" aria-hidden="true" />
              {:else}
                <PlusIcon size={16} class="shrink-0 text-muted-foreground" aria-hidden="true" />
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </section>
  {/if}

  {#if otherAdded.length > 0}
    <section class="flex flex-col gap-1" aria-label="Added">
      {@render groupLine("Added", otherAdded.length)}
      <div class="grid grid-cols-1 gap-2 @min-[40rem]/pane:grid-cols-3">
        {#each otherAdded as added (added.sourceKey)}
          {#snippet removeAction()}
            <Button
              variant="ghost"
              size="icon-sm"
              class="shrink-0 text-muted-foreground pointer-coarse:tap-area"
              aria-label="Remove {added.label}"
              title="Remove {added.label}"
              onclick={() => save(withoutTaskSource(config, added.sourceKey))}
            >
              <XIcon size={14} aria-hidden="true" />
            </Button>
          {/snippet}
          {@render card(taskSourceProvider(added.source), added.label, SOURCE_KIND_SHORT_NAMES[added.source.kind], removeAction)}
        {/each}
      </div>
    </section>
  {/if}

  <section class="flex flex-col gap-2" aria-label="Add a source">
    {@render groupLine(projectRows.length > 0 || otherAdded.length > 0 ? "Add another source" : "Add a source", null)}
    <!-- One card for each provider. Its menu stays open after each add, so
         one provider gives several. -->
    <TaskSourceAdd look="providers" {onChanged} />
  </section>
</div>
