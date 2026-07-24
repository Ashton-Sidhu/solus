<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet, SvelteMap } from "svelte/reactivity";
  import {
    MagnifyingGlassIcon,
    DownloadSimpleIcon,
    CheckIcon,
    ArrowSquareOutIcon,
    SpinnerGapIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { Input } from "../ui/input";
  import { getAgentContext, getWorkspaceContext } from "../../contexts";
  import { buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import type { RemoteSkill } from "../../../shared/types";
  import { Button } from "../ui/button";

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

  function onInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(query), 350);
  }

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
          workspace.activeSession?.workingDirectory ??
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

<div class="flex flex-col gap-4">
  <div>
    <p class="text-[0.8125rem] text-(--solus-text-secondary)">
      Browse the <span class="font-medium text-(--solus-text-primary)">skills.sh</span> registry and install
      skills into all your active agents at once.
    </p>
    {#if activeAgentLabels.length > 0}
      <p class="mt-1 text-[0.6875rem] text-(--solus-text-tertiary)">
        Installs into: {activeAgentLabels.join(", ")}
      </p>
    {/if}
  </div>

  <div class="relative">
    <MagnifyingGlassIcon
      size={14}
      class="absolute left-3 top-1/2 -translate-y-1/2 text-(--solus-text-tertiary) pointer-events-none z-10"
    />
    <Input
      bind:ref={searchEl}
      bind:value={query}
      oninput={onInput}
      onkeydown={onKeydown}
      type="text"
      placeholder="Search skills…"
      class="h-auto w-full rounded-lg border-0 bg-(--solus-input-bg-soft) py-2 pl-9 pr-3 text-[0.7813rem] shadow-[inset_0_0_0_0.0625rem_var(--solus-container-border)] [transition:box-shadow_var(--duration-base)_var(--ease-premium)] focus:shadow-[inset_0_0_0_0.0625rem_var(--solus-input-focus-border),0_0_0_0.1875rem_var(--solus-input-focus-ring)] focus-visible:ring-0 dark:bg-(--solus-input-bg-soft)"
    />
  </div>

  <div class="flex flex-col">
    {#if searching && results.length === 0}
      <div class="py-10 flex items-center justify-center gap-2 text-[0.8125rem] text-(--solus-text-tertiary)">
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
        <div class="flex items-center justify-between gap-4 py-3 border-b border-b-(--solus-container-border)/50 last:border-b-0" data-testid="skill-row">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-[0.8125rem] font-medium text-(--solus-text-primary) truncate">{skill.name}</span>
              {#if skill.url}
                <a
                  href={skill.url}
                  onclick={(e) => { e.preventDefault(); window.solus.openExternal(skill.url); }}
                  class="text-(--solus-text-tertiary) hover:text-(--solus-accent) transition-colors shrink-0"
                  aria-label="Open on skills.sh"
                >
                  <ArrowSquareOutIcon size={12} />
                </a>
              {/if}
            </div>
            <div class="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-(--solus-text-tertiary)">
              <span class="truncate">{skill.repo}</span>
              {#if skill.installs}
                <span class="opacity-50">·</span>
                <span class="shrink-0">{skill.installs} installs</span>
              {/if}
            </div>
            {#if error}
              <div class="mt-1 flex items-center gap-1 text-[0.6875rem] text-(--solus-status-error)">
                <WarningCircleIcon size={12} />
                <span class="truncate">{error}</span>
              </div>
            {/if}
          </div>

          {#if isInstalled}
            <span class="flex items-center gap-[0.3125rem] shrink-0 text-[0.8125rem] font-medium py-1.5 px-3 text-(--solus-accent)" data-testid="skill-installed">
              <CheckIcon size={13} weight="bold" />
              Installed
            </span>
          {:else}
            <Button
              size="sm"
              onclick={() => install(skill)}
              disabled={isInstalling}
              class="shrink-0"
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
        </div>
      {/each}
    {/if}
  </div>
</div>
