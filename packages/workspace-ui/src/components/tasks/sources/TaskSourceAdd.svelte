<script lang="ts">
  import { ChevronDown as CaretDownIcon, Plus as PlusIcon, RefreshCw as RefreshIcon } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { taskSourceKey, taskSourceProvider } from "@solus/contracts/task-sources";
  import { getSettingsContext, getWorkspaceContext, taskSourcesStore } from "../../../contexts";
  import ContentSkeleton from "../../ui/ContentSkeleton.svelte";
  import * as Popover from "../../ui/popover";
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

  /**
   * Add a task source: a GitHub repository, a GitHub Project, a Jira project
   * or a Jira board (docs/tasks.md). Each add is one write of the personal
   * settings; the task host then reads the sources again.
   *
   * Two looks. On the strip of sources it is the quiet last chip. With no
   * source it invites: full-strength text and a hairline, because that is a
   * decision nobody has made yet.
   */
  interface Props {
    /** "invite" when the person has no source. */
    look: "strip" | "invite";
    /** Called after a source is added, so the page reads its tasks again. */
    onChanged?: () => void;
  }
  let { look, onChanged }: Props = $props();

  const settings = getSettingsContext();
  const session = getWorkspaceContext();

  let open = $state(false);
  let query = $state("");

  const config = $derived({ taskSources: settings.taskSources });
  const configured = $derived(config.taskSources);
  const options = $derived(taskSourcesStore.options);
  const optionsError = $derived(taskSourcesStore.optionsError);
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
  const connectionNames = $derived(connectionProviderNames(connectionNotes));
  // The full reasons, for a pointer that rests on the action.
  const connectionHelp = $derived(connectionNotes.map((note) => note.text).join("\n") || undefined);
  const alreadyConfigured = $derived(
    !typedChoice && !!query.trim() && configured.some((source) => taskSourceKey(source) === manualSourceKey(query)),
  );

  // Opening the control is the only moment the choices are worth a provider
  // read, and a person connects GitHub or Jira in between two opens.
  $effect(() => {
    if (!open) return;
    untrack(() => void taskSourcesStore.loadOptions());
  });

  function openIntegrations() {
    open = false;
    session.showSettings("integrations");
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

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      {#if look === "invite"}
        <!-- No source is marked by a hairline and full-strength text, never by
             colour: the accent belongs to the page's one primary action. -->
        <button
          {...props}
          type="button"
          class="flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 bg-transparent px-2.5 font-medium text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors duration-150 hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:min-h-10"
          title="Add a GitHub repository or Project, a Jira project or board, or a Linear team."
        >
          <span class="flex shrink-0 items-center gap-1" aria-hidden="true">
            <SourceLogo source="github" />
            <SourceLogo source="jira" />
            <SourceLogo source="linear" />
          </span>
          <span class="truncate">Add a task source</span>
          <CaretDownIcon size={9} class="shrink-0 opacity-70" />
        </button>
      {:else}
        <!-- The last chip of the strip, in the chips' own geometry. The label
             goes first in a narrow pane; the plus and the title carry it. -->
        <button
          {...props}
          type="button"
          class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 bg-transparent px-2 text-workspace-chrome text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-9"
          aria-label="Add a task source"
          title="Add a GitHub repository or Project, a Jira project or board, or a Linear team."
        >
          <PlusIcon size={16} class="shrink-0" aria-hidden="true" />
          <span class="truncate @max-[30rem]/pane:hidden">Add source</span>
        </button>
      {/if}
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    side="bottom"
    align={look === "invite" ? "center" : "start"}
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[min(24rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    <Command.Root shouldFilter={false}>
      <MenuSearch bind:value={query} placeholder="Search, or paste a GitHub URL" />
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
      <!-- Every connection is made in Settings › Integrations, signed in or not. -->
      <button
        type="button"
        title={connectionHelp}
        class="min-w-0 cursor-pointer truncate rounded-md border-0 bg-transparent px-1.5 py-1 font-medium text-(--solus-text-secondary) transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:py-2"
        onclick={openIntegrations}
      >{connectionNotes.length > 0 ? `Connect ${connectionNames}` : "Manage connections"}</button>
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
  </Popover.Content>
</Popover.Root>
