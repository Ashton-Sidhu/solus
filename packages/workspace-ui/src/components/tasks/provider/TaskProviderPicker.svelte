<script lang="ts">
  import { Check as CheckIcon, ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import type { TaskProviderId } from "@solus/contracts/task-types";
  import { atlassianStore } from "../../../contexts";
  import * as Popover from "../../ui/popover";
  import * as Command from "../../ui/command";
  import { MenuSearch } from "../../ui/menu";
  import { SourceLogo, type ListSourceId } from "../../ui/list-page";
  import {
    githubUnavailableReason,
    jiraUnavailableReason,
    matchesJiraProject,
    taskProviderTrigger,
    type TaskProviderChoice,
  } from "./lib/task-provider";

  /**
   * Where this project's tasks are filed, and the one place to change it.
   *
   * Both directions live here: a project can leave a provider for Local as
   * easily as it joined one, and the trigger always says which it is — the
   * setting was previously reachable only from an empty list, so a project with
   * tasks could never be moved.
   *
   * One control, two voices. Bound, it reports: the provider's own logo, the
   * scope it is pinned to, and the muted weight of a settled setting. Unbound,
   * it invites: the marks it could connect to, full-strength text and a
   * hairline — because "Local tasks" beside a grey sentence read as a finished
   * setting rather than a decision nobody had made yet.
   */
  interface Props {
    provider: TaskProviderId;
    /** How the current binding reads — `owner/repo`, or a Jira project key. */
    scopeLabel: string | null;
    /** The host holding this project; the Jira list belongs to its connection. */
    serverId: string | null;
    detectedRepo?: { owner: string; repo: string } | null;
    onSelect: (choice: TaskProviderChoice) => void;
  }
  let { provider, scopeLabel, serverId, detectedRepo = null, onSelect }: Props = $props();

  let open = $state(false);
  let query = $state("");

  const status = $derived(atlassianStore.status(serverId));
  const reachesJira = $derived(status?.products?.includes("jira") === true);
  const projects = $derived(atlassianStore.jiraProjects(serverId));
  const visibleProjects = $derived(
    projects.filter((project) => matchesJiraProject(project, query)),
  );
  const jiraBlocked = $derived(
    jiraUnavailableReason({
      connected: atlassianStore.connected(serverId),
      reachesJira,
      projectCount: projects.length,
      loading: atlassianStore.jiraProjectsLoading(serverId),
      error: atlassianStore.jiraProjectsError(serverId),
    }),
  );
  const githubBlocked = $derived(githubUnavailableReason(detectedRepo));
  const trigger = $derived(taskProviderTrigger(provider, scopeLabel, detectedRepo));

  // Opening the menu is the only moment the Jira list is worth fetching, and
  // the only moment the connection state needs to be current.
  $effect(() => {
    if (!open || !serverId) return;
    void atlassianStore.ensureStatus(serverId).then(() => {
      if (atlassianStore.status(serverId)?.products?.includes("jira")) {
        void atlassianStore.loadJiraProjects(serverId);
      }
    });
  });

  function choose(choice: TaskProviderChoice) {
    open = false;
    query = "";
    onSelect(choice);
  }

  function chooseGitHub() {
    if (!detectedRepo) return;
    choose({ provider: "github" });
  }
</script>

<!-- A fixed cell, because the local mark is a 5px dot and the brand logos are
     15px: without it every label in the menu sits at a different x. -->
{#snippet providerCell(source: ListSourceId)}
  <span class="flex w-[15px] shrink-0 items-center justify-center">
    <SourceLogo {source} />
  </span>
{/snippet}

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <!-- The header's own geometry — the same 30px row the primary action and
           the view switcher stand on, 26px on a laptop display. No font size is
           pinned: the page declares its rung once (`text-chrome-dense`) and
           every control in this row inherits it, so the type follows the
           display instead of freezing at 12px.

           Unbound is marked by a hairline and full-strength text, never by
           colour: the accent belongs to the one primary action beside it. -->
      <button
        {...props}
        type="button"
        class="flex h-[30px] [.is-laptop-display_&]:h-[26px] shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 bg-transparent px-2.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] [@media(pointer:coarse)]:min-h-10 {trigger.unbound
          ? 'font-medium text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:bg-[var(--wash-2)]'
          : 'text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground'}"
        aria-label="Task provider"
        title={trigger.title}
      >
        {#if trigger.unbound}
          <!-- The two systems this project could file in: the pill says what it
               offers before its label is read. -->
          <span class="flex shrink-0 items-center gap-1" aria-hidden="true">
            <SourceLogo source="github" />
            <SourceLogo source="jira" />
          </span>
        {:else if provider !== "local"}
          <SourceLogo source={provider} />
        {/if}
        <!-- The label is the first thing to go at the record rung: the crumb
             line has ~90px of slack there and this pill wanted 187 of it, so it
             shoved the page name into the window controls. The logos already
             say which systems this offers, and the title carries the rest. -->
        <span class="truncate @max-[30rem]/pane:hidden">{trigger.label}</span>
        <CaretDownIcon
          size={9}
          class="shrink-0 opacity-70 @max-[30rem]/pane:hidden"
        />
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[min(18rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    <Command.Root>
      <MenuSearch bind:value={query} placeholder="Search providers" />
      <Command.List class="max-h-[280px] overflow-y-auto p-1.5">
        <Command.Empty
          class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)"
        >
          Nothing matches
        </Command.Empty>
        <Command.Group heading="File tasks in">
          <Command.Item
            value="local solus tasks"
            onSelect={() => choose({ provider: "local" })}
            data-menu-current={provider === "local" ? "" : undefined}
          >
            {@render providerCell("local")}
            <span class="min-w-0 flex-1 truncate">Local tasks</span>
            {#if provider === "local"}
              <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
            {/if}
          </Command.Item>
          <Command.Item
            value="github issues"
            onSelect={chooseGitHub}
            disabled={!!githubBlocked}
            data-menu-current={provider === "github" ? "" : undefined}
          >
            {@render providerCell("github")}
            <span class="shrink-0">GitHub</span>
            <!-- The repository GitHub would bind, named on the row that binds it
                 rather than in the trigger, which does not do the binding. -->
            {#if detectedRepo}
              <span class="min-w-0 flex-1 truncate text-(--solus-text-tertiary)">
                {detectedRepo.owner}/{detectedRepo.repo}
              </span>
            {:else}
              <span class="flex-1"></span>
            {/if}
            {#if provider === "github"}
              <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
            {/if}
          </Command.Item>
          {#if githubBlocked}
            <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">
              {githubBlocked}
            </p>
          {/if}
        </Command.Group>

        <div class="mx-1 my-1.5 h-px bg-(--solus-menu-hairline)"></div>

        <Command.Group heading="Jira project">
          {#if jiraBlocked}
            <!-- Stated, not hidden: a missing row reads as "Solus cannot do
                 this", when the truth is one connection away. -->
            <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">
              {jiraBlocked}
            </p>
          {:else if atlassianStore.jiraProjectsLoading(serverId) && !projects.length}
            <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">
              Loading projects…
            </p>
          {:else}
            {#each visibleProjects as project (project.key)}
              {@const current = provider === "jira" && scopeLabel === project.key}
              <Command.Item
                value="jira {project.key} {project.name}"
                onSelect={() =>
                  choose({ provider: "jira", projectKey: project.key })}
                data-menu-current={current ? "" : undefined}
              >
                {@render providerCell("jira")}
                <span class="shrink-0 font-medium">{project.key}</span>
                <span class="min-w-0 flex-1 truncate text-(--solus-text-tertiary)">
                  {project.name}
                </span>
                {#if current}
                  <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                {/if}
              </Command.Item>
            {/each}
          {/if}
        </Command.Group>
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
