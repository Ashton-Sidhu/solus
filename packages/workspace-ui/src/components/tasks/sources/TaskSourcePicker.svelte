<script lang="ts">
  import { Plus as PlusIcon, RefreshCw as RefreshIcon } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { taskSourceKey, taskSourceProvider } from "@solus/contracts/task-sources";
  import { getSettingsContext, getSurfaceContext, taskHostId, taskSourcesStore } from "../../../contexts";
  import ContentSkeleton from "../../ui/ContentSkeleton.svelte";
  import * as Command from "../../ui/command";
  import { MenuSearch } from "../../ui/menu";
  import { SourceLogo } from "../../ui/list-page";
  import {
    SOURCE_PROVIDER_NAMES,
    manualSourceChoice,
    manualSourceKey,
    matchingChoices,
    sourceChoiceGroups,
    sourceConnectionNotes,
    withTaskSource,
    type SourceChoice,
    type SourceConnectionNote,
  } from "./lib/task-source-setup";
  import { saveTaskSources } from "./lib/save-task-sources.svelte";
  import { MenuLinearKey } from "./lib/menu-linear-key.svelte";

  /**
   * What a person can add as a task source, with a search that also takes a
   * typed `owner/repo` or a pasted GitHub URL (docs/tasks.md): GitHub
   * repositories and Projects, Jira projects and boards, and Linear teams.
   * Each add is one write of the personal settings, and an added source leaves
   * the list, so a person adds several in a row. It is the body of the menu
   * that adds a source.
   */
  interface Props {
    /** While true, the choices are read and Linear's key is followed. */
    active: boolean;
    /** Called after a source is added, so the page reads its tasks again. */
    onChanged?: () => void;
    /** Called before the picker sends the person to Settings. */
    onLeave?: () => void;
    /** Opens the dialog that connects the provider in place. */
    onConnect?: (provider: SourceConnectionNote["provider"]) => void;
    /** Only this provider's choices, as its button on the setup asks. */
    provider?: SourceProvider | null;
  }
  let { active, onChanged, onLeave, onConnect, provider = null }: Props = $props();

  type SourceProvider = ReturnType<typeof taskSourceProvider>;
  const isProviderShown = (shown: SourceProvider) => provider === null || provider === shown;

  const settings = getSettingsContext();
  const session = getSurfaceContext();

  let query = $state("");

  const config = $derived({ taskSources: settings.taskSources });
  const configured = $derived(config.taskSources);
  const options = $derived(taskSourcesStore.options);
  const optionsError = $derived(taskSourcesStore.optionsError);
  const groups = $derived(options ? sourceChoiceGroups(options, configured) : []);
  // A repository or a Project that the host did not list: typed as
  // `owner/repo`, or pasted as a github.com URL. It needs no answer from the
  // host, so it is offered while the listed choices still load.
  const typedChoice = $derived(isProviderShown("github") ? manualSourceChoice(query, configured, groups) : null);
  const searchHint = $derived(
    provider === "jira" ? "Search Jira projects and boards"
      : provider === "linear" ? "Search Linear teams"
      : "Search, or paste a GitHub URL",
  );
  const offered = $derived(
    groups
      .flatMap((group) => matchingChoices(group, query))
      .filter((choice) => choice.sourceKey !== typedChoice?.sourceKey && isProviderShown(taskSourceProvider(choice.source))),
  );
  // Whether this person may save a Linear key here, so its connect action
  // opens the key dialog instead of Settings. Read again on each open.
  const linearKey = $derived.by(() => {
    const serverId = active ? taskHostId() : null;
    return serverId ? new MenuLinearKey(serverId) : null;
  });
  // A connection problem is worth the footer only while a person browses, not
  // while they search for one source by name.
  const connectionNotes = $derived(
    options && !query.trim() ? sourceConnectionNotes(options).filter((note) => isProviderShown(note.provider)) : [],
  );
  const alreadyConfigured = $derived(
    !typedChoice && !!query.trim() && configured.some((source) => taskSourceKey(source) === manualSourceKey(query)),
  );

  // Opening the picker is the only moment the choices are worth a provider
  // read, and a person connects GitHub or Jira in between two opens.
  $effect(() => {
    if (!active) return;
    untrack(() => void taskSourcesStore.loadOptions());
  });
  $effect(() => {
    const key = linearKey;
    if (!key) return;
    const stop = key.watch();
    untrack(() => void key.connection.load());
    return stop;
  });

  function openIntegrations() {
    onLeave?.();
    session.workspace?.showSettings("integrations");
  }

  // A provider connects in a dialog: GitHub signs in (again, for the Projects
  // scope), Jira signs in, and Linear takes a key. Every other repair, such
  // as an Atlassian site without Jira, is in Settings. The GitHub sign-in
  // needs the workspace.
  function connectAction(shown: SourceConnectionNote["provider"]): (() => void) | null {
    if (onConnect && shown === "github" && session.workspace) return () => onConnect("github");
    if (onConnect && shown === "jira" && !options?.jira.connected) return () => onConnect("jira");
    if (onConnect && shown === "linear" && linearKey?.canSave) return () => onConnect("linear");
    return session.workspace ? openIntegrations : null;
  }

  function add(choice: SourceChoice) {
    query = "";
    if (saveTaskSources(settings, withTaskSource(config, choice.source))) onChanged?.();
  }
</script>

{#snippet choiceRow(choice: SourceChoice)}
  <Command.Item value={choice.sourceKey} onSelect={() => add(choice)}>
    <span class="flex w-[15px] shrink-0 items-center justify-center">
      <SourceLogo source={taskSourceProvider(choice.source)} />
    </span>
    <span class="min-w-0 flex-1 truncate">{choice.label}</span>
    {#if choice.detail}
      <span class="max-w-[45%] shrink-0 truncate text-xs text-(--solus-text-tertiary)">{choice.detail}</span>
    {/if}
    <PlusIcon size={12} class="shrink-0 text-(--solus-text-tertiary)" />
  </Command.Item>
{/snippet}

<div class="flex flex-col rounded-[inherit]">
  <Command.Root shouldFilter={false}>
    <MenuSearch bind:value={query} placeholder={searchHint} />
    <Command.List class="max-h-[280px] overflow-y-auto p-1.5">
      {#if typedChoice}
        {@render choiceRow(typedChoice)}
      {/if}
      {#if !options && optionsError}
        <p class="px-2.5 py-2 text-xs text-(--failure)" role="alert">
          Couldn't read what you can add: {optionsError}
        </p>
      {:else if !options}
        <ContentSkeleton label="Loading sources" />
      {:else}
        <!-- One flat list: each row says its kind, so the menu has no heading
             for each kind. The typed source has its own row above. -->
        {#each offered as choice (choice.sourceKey)}
          {@render choiceRow(choice)}
        {/each}
        {#if !typedChoice && offered.length === 0}
          <p class="m-0 px-2.5 py-2 text-xs text-(--solus-text-tertiary)">
            {#if alreadyConfigured}
              You have that source already.
            {:else if query.trim()}
              Nothing matches. Type owner/repo, or paste the URL of a GitHub repository or Project.
            {:else if connectionNotes.length === 0}
              You have every source your connections offer. Paste a GitHub URL to add another.
            {/if}
          </p>
        {/if}
      {/if}
    </Command.List>
  </Command.Root>
  <!-- One row: a connect action for each provider that keeps its sources out
       of the list, with its full reason as a tooltip. -->
  <div
    class="flex min-w-0 items-center gap-0.5 rounded-b-[inherit] border-t border-(--solus-menu-hairline) bg-(--solus-menu-footer-bg) py-1 pr-1.5 pl-1.5 text-xs text-(--solus-text-tertiary)"
  >
    {#if connectionNotes.length > 0}
      <span class="shrink-0 px-1.5">Connect</span>
      {#each connectionNotes as note (note.provider)}
        {@const action = connectAction(note.provider)}
        <button
          type="button"
          title={note.text}
          aria-label={note.text}
          disabled={!action}
          class="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 font-medium text-(--solus-text-secondary) transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:h-9"
          onclick={() => action?.()}
        >
          <SourceLogo source={note.provider} />
          <span class="truncate">{SOURCE_PROVIDER_NAMES[note.provider]}</span>
        </button>
      {/each}
    {:else if session.workspace}
      <!-- A surface with no workspace has no Settings to open. -->
      <button
        type="button"
        class="h-7 min-w-0 cursor-pointer truncate rounded-md border-0 bg-transparent px-1.5 font-medium text-(--solus-text-secondary) transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-9"
        onclick={openIntegrations}
      >Manage connections</button>
    {/if}
    <button
      type="button"
      class="ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-9"
      aria-label="Refresh sources"
      title="Refresh sources"
      onclick={() => void taskSourcesStore.loadOptions()}
    >
      <RefreshIcon size={13} aria-hidden="true" />
    </button>
  </div>
</div>
