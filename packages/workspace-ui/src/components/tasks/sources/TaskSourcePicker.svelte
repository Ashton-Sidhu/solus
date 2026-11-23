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
    connectionProviderNames,
    manualSourceChoice,
    manualSourceKey,
    matchingChoices,
    sourceChoiceGroups,
    sourceConnectionNotes,
    withTaskSource,
    type SourceChoice,
  } from "./lib/task-source-setup";
  import { saveTaskSources } from "./lib/save-task-sources.svelte";
  import { MenuLinearKey } from "./lib/menu-linear-key.svelte";
  import LinearKeyField from "./LinearKeyField.svelte";

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
    /** Only this provider's choices, as its button on the setup asks. */
    provider?: SourceProvider | null;
  }
  let { active, onChanged, onLeave, provider = null }: Props = $props();

  type SourceProvider = ReturnType<typeof taskSourceProvider>;
  const isProviderShown = (shown: SourceProvider) => provider === null || provider === shown;

  const settings = getSettingsContext();
  const session = getSurfaceContext();

  let query = $state("");
  let root = $state<HTMLElement | null>(null);

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
  // Linear connects with a pasted key, so the menu takes it in place: the person
  // picks a team without a trip to Settings. Read again on each open.
  const linearKey = $derived.by(() => {
    const serverId = active ? taskHostId() : null;
    return serverId ? new MenuLinearKey(serverId) : null;
  });
  const offersLinearKey = $derived(
    !!linearKey?.canSave && !!options?.linear && !options.linear.connected && !query.trim() && isProviderShown("linear"),
  );
  // A connection problem is worth a line only while a person browses, not
  // while they search for one source by name. Linear's is the key field when
  // the menu offers it.
  const connectionNotes = $derived(
    options && !query.trim()
      ? sourceConnectionNotes(options).filter(
          (note) => isProviderShown(note.provider) && !(offersLinearKey && note.provider === "linear"),
        )
      : [],
  );
  const connectionNames = $derived(connectionProviderNames(connectionNotes));
  // The full reasons, for a pointer that rests on the action.
  const connectionHelp = $derived(connectionNotes.map((note) => note.text).join("\n") || undefined);
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

  // The teams read again, and the search takes the keys for the next step.
  function linearConnected() {
    void taskSourcesStore.loadOptions();
    root?.querySelector<HTMLInputElement>("input")?.focus();
  }

  function openIntegrations() {
    onLeave?.();
    session.workspace?.showSettings("integrations");
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

<div bind:this={root} class="flex flex-col rounded-[inherit]">
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
            {:else if connectionNotes.length === 0 && !offersLinearKey}
              You have every source your connections offer. Paste a GitHub URL to add another.
            {/if}
          </p>
        {/if}
      {/if}
    </Command.List>
  </Command.Root>
  {#if offersLinearKey && linearKey}
    <LinearKeyField {linearKey} problem={options?.linear?.error} onConnected={linearConnected} />
  {/if}
  <!-- What keeps a source out of the list, and where to fix it, in one
       row: each logo carries its own reason as a tooltip. -->
  <div
    class="flex items-center gap-1 rounded-b-[inherit] border-t border-(--solus-menu-hairline) bg-(--solus-menu-footer-bg) py-1 pr-1.5 pl-2.5 text-xs text-(--solus-text-tertiary)"
  >
    {#if connectionNotes.length > 0}
      <span class="flex shrink-0 items-center gap-1 pl-1.5">
        {#each connectionNotes as note (note.text)}
          <SourceLogo source={note.provider} title={note.text} />
        {/each}
      </span>
    {/if}
    <!-- Every connection is made in Settings › Integrations, signed in or not.
         A surface with no workspace has no Settings to open. -->
    {#if session.workspace}
    <button
      type="button"
      title={connectionHelp}
      class="min-w-0 cursor-pointer truncate rounded-md border-0 bg-transparent px-1.5 py-1 font-medium text-(--solus-text-secondary) transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:py-2"
      onclick={openIntegrations}
    >{connectionNotes.length > 0 ? `Connect ${connectionNames}` : "Manage connections"}</button>
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
