<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet, SvelteMap } from "svelte/reactivity";
  import {
    DownloadSimpleIcon,
    CheckIcon,
    ArrowSquareOutIcon,
    SpinnerGapIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { SearchField } from "../ui/search-field";
  import { getAgentContext, getWorkspaceContext } from "../../contexts";
  import { buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import type { RemoteSkill } from "../../../shared/types";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  const agentContext = getAgentContext();
  const workspace = getWorkspaceContext();

  // Labels of the providers a skill will be installed into — surfaced so the
  // user knows the install fans out across every active agent, not just one.
  const activeAgentLabels = $derived(
    buildAgentAvailabilityRows(agentContext.agents, agentContext.metadata)
      .filter((a) => a.enabled)
      .map((a) => a.label),
  );

  let query = $state("");
  let searchEl = $state<HTMLInputElement | null>(null);
  let results = $state<RemoteSkill[]>([]);
  const visibleResults = $derived(results.slice(0, 10));
  let searching = $state(false);
  let hasSearched = $state(false);

  // Skill ids installed from this view — used to render success feedback.
  const installedIds = new SvelteSet<string>();
  // Install targets currently in flight, keyed by skill id.
  const installing = new SvelteSet<string>();
  // Per-skill install errors, keyed by skill id.
  const installErrors = new SvelteMap<string, string>();

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // Guards against a slow earlier search overwriting a newer one.
  let searchSeq = 0;

  onMount(() => {
    searchEl?.focus();
  });

  async function runSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) {
      results = [];
      hasSearched = false;
      searching = false;
      return;
    }
    const seq = ++searchSeq;
    searching = true;
    const found = await window.solus.skillsSearch(trimmed);
    if (seq !== searchSeq) return; // a newer search superseded this one
    results = found;
    hasSearched = true;
    searching = false;
  }

  // SearchField owns the input (and its clear button), so the debounce hangs off
  // the bound value rather than an `oninput` handler.
  $effect(() => {
    const q = query;
    debounceTimer = setTimeout(() => void runSearch(q), 350);
    return () => clearTimeout(debounceTimer);
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(debounceTimer);
      void runSearch(query);
    }
  }

  async function install(skill: RemoteSkill) {
    if (installing.has(skill.id) || installedIds.has(skill.id)) return;
    installErrors.delete(skill.id);
    installing.add(skill.id);
    try {
      const result = await window.solus.skillsInstall(skill.id);
      if (result.ok) {
        installedIds.add(skill.id);
        // The main-process command caches are cleared by the install handler, but
        // the renderer's cached `pluginCommands` (which feeds the slash menu) is
        // only refreshed on agent/dir switches. Without this, a skill installed
        // while the agent stays put — notably Claude, whose skills are sourced
        // live — isn't discoverable until the next switch. Re-fetch now.
        const cwd =
          workspace.activeSession?.run.workingDirectory ??
          workspace.globalDefaults.workingDirectory;
        void workspace.refreshPluginCommands(cwd);
      } else {
        installErrors.set(skill.id, result.error || "Install failed");
      }
    } catch (err) {
      installErrors.set(skill.id, err instanceof Error ? err.message : "Install failed");
    } finally {
      installing.delete(skill.id);
      searchEl?.focus();
    }
  }
</script>

<div>
  <!-- Row flex, not column: SearchField's `basis-56` sizes the main axis, so a
       column parent would stretch the field to 14rem tall. -->
  <div class="flex items-center">
    <SearchField
      bind:ref={searchEl}
      bind:value={query}
      onkeydown={onKeydown}
      placeholder="Search skills.sh…"
      class="rounded-md py-1 [&_input]:text-[0.75rem]"
    />
  </div>
  {#if activeAgentLabels.length > 0}
    <p class="mt-2 px-0.5 text-[0.6875rem] text-(--solus-text-tertiary)">
      Installs into: {activeAgentLabels.join(", ")}
    </p>
  {/if}
</div>

<SettingsSection label="Results">
  {#if searching && results.length === 0}
    <div class="flex items-center justify-center gap-2 py-10 text-[0.8125rem] text-(--solus-text-tertiary)">
      <SpinnerGapIcon size={15} class="animate-spin" />
      Searching skills.sh…
    </div>
  {:else if hasSearched && results.length === 0}
    <div class="py-10 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      No skills found for "{query.trim()}"
    </div>
  {:else if !hasSearched}
    <div class="py-10 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      Type to search the skills registry
    </div>
  {:else}
    {#each visibleResults as skill (skill.id)}
      {@const isInstalled = installedIds.has(skill.id)}
      {@const isInstalling = installing.has(skill.id)}
      {@const error = installErrors.get(skill.id)}
      {#snippet installError()}
        <div class="flex items-center gap-1 text-[0.6875rem] text-(--solus-status-error)">
          <WarningCircleIcon size={12} />
          <span class="truncate">{error}</span>
        </div>
      {/snippet}
      <SettingsRow
        testId="skill-row"
        label={skill.name}
        description={skill.installs
          ? `${skill.repo} · ${skill.installs} installs`
          : skill.repo}
        body={error ? installError : undefined}
      >
        {#snippet labelExtra()}
          {#if skill.url}
            <a
              href={skill.url}
              onclick={(e) => { e.preventDefault(); window.solus.openExternal(skill.url); }}
              class="ml-1.5 inline-flex align-middle text-(--solus-text-tertiary) transition-colors hover:text-(--solus-accent)"
              aria-label="Open {skill.name} on skills.sh"
            >
              <ArrowSquareOutIcon size={12} />
            </a>
          {/if}
        {/snippet}
        {#snippet control()}
          {#if isInstalled}
            <span
              class="flex items-center gap-[0.3125rem] px-3 py-1.5 text-[0.8125rem] font-medium text-(--solus-accent)"
              data-testid="skill-installed"
            >
              <CheckIcon size={13} weight="bold" />
              Installed
            </span>
          {:else}
            <Button
              size="sm"
              onclick={() => install(skill)}
              disabled={isInstalling}
              data-testid="skill-install"
            >
              {#if isInstalling}
                <SpinnerGapIcon size={13} class="animate-spin" />
                Installing…
              {:else}
                <DownloadSimpleIcon size={13} />
                Install
              {/if}
            </Button>
          {/if}
        {/snippet}
      </SettingsRow>
    {/each}
  {/if}
</SettingsSection>
