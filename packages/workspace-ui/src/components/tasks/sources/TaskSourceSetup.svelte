<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    Plus as PlusIcon,
    Star as StarIcon,
    TriangleAlert as WarningIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { taskSourceKey, taskSourceProvider } from "@solus/contracts/task-sources";
  import type { ProjectConfig } from "@solus/contracts/types";
  import { getProjectConfigStore, taskSourcesStore } from "../../../contexts";
  import { toasts } from "../../../lib/toasts";
  import ContentSkeleton from "../../ui/ContentSkeleton.svelte";
  import * as Popover from "../../ui/popover";
  import * as Command from "../../ui/command";
  import { MenuSearch } from "../../ui/menu";
  import { SourceLogo } from "../../ui/list-page";
  import {
    SOURCE_KIND_SHORT_NAMES,
    defaultSourceKeyOf,
    manualSourceChoice,
    manualSourceKey,
    matchingChoices,
    sourceChoiceGroups,
    sourceConnectionNotes,
    sourceHealthNote,
    sourceSetupTrigger,
    taskSourceLabel,
    withDefaultTaskSource,
    withTaskSource,
    withoutTaskSource,
    type SourceChoice,
  } from "./lib/task-source-setup";

  /**
   * The task sources of one project, and the one place to change them
   * (docs/plans/provider-owned-tasks.md §7).
   *
   * GitHub and Jira own every task, so a project with no source has no tasks.
   * This control lists the project's sources with the state of each one's last
   * read, removes one, chooses the default source (where a new task is
   * created), and adds a GitHub repository, a GitHub Project, a Jira project
   * or a Jira board. Each change is one project config write on the host that
   * has the project; the host then reads the sources again.
   *
   * One control, two voices. With sources, it reports them in the muted weight
   * of a settled setting. With none, it invites: full-strength text and a
   * hairline, because that is a decision nobody has made yet.
   */
  interface Props {
    /** The host that has the project. */
    serverId: string;
    /** The project's root folder on that host. */
    cwd: string;
    /** Called after a change is saved, so the page reads its tasks again. */
    onChanged?: () => void;
  }
  let { serverId, cwd, onChanged }: Props = $props();

  const projectConfig = getProjectConfigStore();

  let open = $state(false);
  let query = $state("");
  let saving = $state(false);

  const config = $derived(projectConfig.configFor(serverId, cwd) ?? null);
  const configured = $derived(config?.taskSources ?? []);
  const defaultSourceKey = $derived(config ? defaultSourceKeyOf(config) : undefined);
  // The host's last read of each source. A source the host has not read yet
  // (it was added a moment ago) still shows, with its own fallback label.
  const states = $derived(taskSourcesStore.sourcesFor(serverId, cwd)?.sources ?? []);
  const rows = $derived(
    configured.map((source) => {
      const sourceKey = taskSourceKey(source);
      const state = states.find((candidate) => candidate.sourceKey === sourceKey);
      return {
        source,
        sourceKey,
        label: state?.label ?? taskSourceLabel(source),
        refreshing: state?.refreshing === true,
        note: state ? sourceHealthNote(state) : null,
      };
    }),
  );
  const trigger = $derived(sourceSetupTrigger(states));
  const options = $derived(taskSourcesStore.optionsFor(serverId, cwd));
  const optionsError = $derived(taskSourcesStore.optionsErrorFor(serverId, cwd));
  const groups = $derived(options ? sourceChoiceGroups(options, configured) : []);
  // A repository or a Project that the host did not list: typed as
  // `owner/repo`, or pasted as a github.com URL. It needs no answer from the
  // host, so it is offered while the listed choices still load.
  const typedChoice = $derived(manualSourceChoice(query, configured, groups));
  const offered = $derived(
    groups
      .flatMap((group) => matchingChoices(group, query))
      .filter((choice) => choice.sourceKey !== typedChoice?.sourceKey),
  );
  // A connection problem is worth a line only while a person browses, not
  // while they search for one source by name.
  const connectionNotes = $derived(options && !query.trim() ? sourceConnectionNotes(options) : []);
  const alreadyConfigured = $derived(
    !typedChoice && !!query.trim() && rows.some((row) => row.sourceKey === manualSourceKey(query)),
  );

  // The list and each change start from the config the host holds. With no
  // read, a project that has sources shows as one that has none, and the first
  // change is written over them.
  $effect(() => {
    const host = { serverId, api: serverConnections.apiFor(serverId) };
    const projectRoot = cwd;
    untrack(() => void projectConfig.load(host, projectRoot).catch(() => null));
  });

  // Opening the setup is the only moment the choices are worth a provider
  // read, and a person connects GitHub or Jira in between two opens.
  $effect(() => {
    if (!open) return;
    const host = serverId;
    const projectRoot = cwd;
    untrack(() => void taskSourcesStore.loadOptions(host, projectRoot));
  });

  /** One project config write. A failed write shows its error, and the config
   *  is read again so the list shows what the host holds. */
  async function save(patch: Pick<ProjectConfig, "taskSources" | "defaultTaskSource"> | null) {
    if (!patch || saving) return;
    const host = { serverId, api: serverConnections.apiFor(serverId) };
    saving = true;
    try {
      await projectConfig.save(host, cwd, patch);
      await taskSourcesStore.loadHost(serverId, { cwd });
      onChanged?.();
    } catch (error) {
      toasts.error("Couldn't save the task sources", {
        description: error instanceof Error ? error.message : String(error),
      });
      await projectConfig.load(host, cwd).catch(() => null);
    } finally {
      saving = false;
    }
  }

  function add(choice: SourceChoice) {
    query = "";
    void save(withTaskSource(config ?? {}, choice.source));
  }
</script>

{#snippet choiceRow(choice: SourceChoice)}
  <Command.Item value={choice.sourceKey} disabled={saving} onSelect={() => add(choice)}>
    <span class="flex w-[15px] shrink-0 items-center justify-center">
      <SourceLogo source={taskSourceProvider(choice.source)} />
    </span>
    <span class="min-w-0 shrink truncate">{choice.label}</span>
    <span class="min-w-0 flex-1 truncate text-xs text-(--solus-text-tertiary)">{choice.detail ?? ""}</span>
    <PlusIcon size={12} class="shrink-0 text-(--solus-text-tertiary)" />
  </Command.Item>
{/snippet}

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <!-- The header's own geometry: the same 30px row the primary action and
           the view switcher stand on. No font size is pinned: the page declares
           its rung once and every control in this row inherits it.

           No source is marked by a hairline and full-strength text, never by
           colour: the accent belongs to the one primary action beside it. -->
      <button
        {...props}
        type="button"
        class="flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 bg-transparent px-2.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] [@media(pointer:coarse)]:min-h-10 {trigger.unset
          ? 'font-medium text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:bg-[var(--wash-2)]'
          : 'text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground'}"
        aria-label="Task sources"
        title={trigger.title}
      >
        {#if trigger.unset}
          <span class="flex shrink-0 items-center gap-1" aria-hidden="true">
            <SourceLogo source="github" />
            <SourceLogo source="jira" />
          </span>
        {:else if trigger.needsAttention}
          <WarningIcon size={13} class="shrink-0 text-(--warning)" aria-hidden="true" />
        {:else if rows.length === 1}
          <SourceLogo source={taskSourceProvider(rows[0].source)} />
        {/if}
        <!-- The label is the first thing to go at the record rung: the crumb
             line has little slack there. The marks and the title carry the rest. -->
        <span class="truncate @max-[30rem]/pane:hidden">{trigger.label}</span>
        <CaretDownIcon size={9} class="shrink-0 opacity-70 @max-[30rem]/pane:hidden" />
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[min(21rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    {#if rows.length > 0}
      <!-- One line for each source: its name, its kind, and the two things a
           person does to it. The star says where a new task goes; Remove
           waits for the pointer or the focus, so a settled list stays quiet. -->
      <ul class="m-0 flex list-none flex-col p-1.5" aria-label="Task sources of this project">
        {#each rows as row (row.sourceKey)}
          {@const isDefault = row.sourceKey === defaultSourceKey}
          <li class="group/source flex min-w-0 flex-col rounded-lg px-2 py-1 hover:bg-(--solus-surface-hover) focus-within:bg-(--solus-surface-hover)">
            <div class="flex h-7 min-w-0 items-center gap-2 pointer-coarse:h-10">
              <span class="flex w-[15px] shrink-0 items-center justify-center">
                <SourceLogo source={taskSourceProvider(row.source)} />
              </span>
              <span class="min-w-0 shrink truncate" title={row.label}>{row.label}</span>
              <span class="min-w-0 flex-1 truncate text-xs text-(--solus-text-tertiary)">
                {row.refreshing ? "Reading…" : SOURCE_KIND_SHORT_NAMES[row.source.kind]}
              </span>
              <button
                type="button"
                class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) opacity-0 transition-opacity duration-100 group-focus-within/source:opacity-100 group-hover/source:opacity-100 hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-default disabled:opacity-50 pointer-coarse:size-9 pointer-coarse:opacity-100"
                disabled={saving}
                aria-label={`Remove ${row.label}`}
                title="Remove this source from the project. The tasks stay on the provider."
                onclick={() => void save(withoutTaskSource(config ?? {}, row.sourceKey))}
              >
                <XIcon size={12} />
              </button>
              <button
                type="button"
                class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent transition-opacity duration-100 focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-default pointer-coarse:size-9 {isDefault
                  ? 'text-(--solus-text-primary)'
                  : 'text-(--solus-text-tertiary) opacity-0 group-focus-within/source:opacity-100 group-hover/source:opacity-100 hover:text-(--solus-text-primary) pointer-coarse:opacity-100'}"
                disabled={isDefault || saving}
                aria-pressed={isDefault}
                aria-label={isDefault ? `${row.label} is the default source` : `Make ${row.label} the default source`}
                title={isDefault ? "New tasks are created here" : "Create new tasks here"}
                onclick={() => void save(withDefaultTaskSource(config ?? {}, row.sourceKey))}
              >
                <StarIcon size={12} fill={isDefault ? "currentColor" : "none"} />
              </button>
            </div>
            {#if row.note}
              <p
                class="m-0 pb-1 pl-[23px] text-xs {row.note.tone === 'failure'
                  ? 'text-(--failure)'
                  : 'text-(--warning)'}"
                role="status"
              >
                <span class="font-medium">{row.note.label}.</span>
                {row.note.message}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
      <div class="mx-1 h-px bg-(--solus-menu-hairline)"></div>
    {/if}

    <Command.Root shouldFilter={false}>
      <MenuSearch bind:value={query} placeholder={rows.length ? "Add a source" : "Add a task source"} />
      <Command.List class="max-h-[240px] overflow-y-auto p-1.5">
        {#if typedChoice}
          {@render choiceRow(typedChoice)}
        {/if}
        {#if !options && optionsError}
          <p class="px-2.5 py-2 text-xs text-(--failure)" role="alert">
            Couldn't read what this project can use: {optionsError}
          </p>
        {:else if !options}
          <ContentSkeleton label="Loading sources" />
        {:else}
          <!-- One flat list: each row says its kind, so the menu has no heading
               for each kind. The typed source has its own row above. -->
          {#each offered as choice (choice.sourceKey)}
            {@render choiceRow(choice)}
          {/each}
          {#each connectionNotes as note (note)}
            <p class="m-0 px-2.5 py-1.5 text-xs text-(--solus-text-tertiary)">{note}</p>
          {/each}
          {#if !typedChoice && offered.length === 0}
            <p class="m-0 px-2.5 py-2 text-xs text-(--solus-text-tertiary)">
              {#if alreadyConfigured}
                This project lists that source already.
              {:else if query.trim()}
                Nothing matches. Type owner/repo, or paste the URL of a GitHub repository or Project.
              {:else if connectionNotes.length === 0}
                Each source GitHub and Jira offer is added. Paste a GitHub URL to add another.
              {/if}
            </p>
          {/if}
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
