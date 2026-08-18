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
  import {
    getAgentContext,
    getWorkspaceContext,
    hostCapabilitiesStore,
  } from "../../contexts";
  import { buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import type { RemoteSkill } from "../../../shared/types";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { localApi } from "@client-core/local-api";
  import { serverConnections } from "@client-core/server-connections";
  import { hostKey } from "@client-core/host-key";
  import type { HostApi } from "@client-core/host-api";
  import { supportsSettingsSurface } from "@client-core/host-capabilities";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";

  interface Props {
    serverId: string;
    api: HostApi;
    hostLabel: string;
  }
  let { serverId, api, hostLabel }: Props = $props();

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
  const capabilities = $derived(hostCapabilitiesStore.for(serverId));
  const isSupported = $derived(supportsSettingsSurface(capabilities, "skills"));
  const canInstall = $derived(capabilities?.skillsInstall === true);

  $effect(() => {
    void hostCapabilitiesStore.load(serverId);
  });

  onMount(() => {
    searchEl?.focus();
  });

  async function runSearch(q: string, targetServerId: string, targetApi: HostApi) {
    const seq = ++searchSeq;
    const trimmed = q.trim();
    if (!isSupported) return;
    if (!trimmed) {
      results = [];
      hasSearched = false;
      searching = false;
      return;
    }
    searching = true;
    const found = await targetApi.skillsSearch(trimmed);
    if (seq !== searchSeq || targetServerId !== serverId) return;
    results = found;
    hasSearched = true;
    searching = false;
  }

  // SearchField owns the input (and its clear button), so the debounce hangs off
  // the bound value rather than an `oninput` handler.
  $effect(() => {
    const q = query;
    const targetServerId = serverId;
    const targetApi = api;
    debounceTimer = setTimeout(
      () => void runSearch(q, targetServerId, targetApi),
      350,
    );
    return () => clearTimeout(debounceTimer);
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(debounceTimer);
      void runSearch(query, serverId, api);
    }
  }

  async function install(skill: RemoteSkill) {
    if (!canInstall) return;
    const installKey = hostKey(serverId, skill.id);
    if (installing.has(installKey) || installedIds.has(installKey)) return;
    installErrors.delete(installKey);
    installing.add(installKey);
    try {
      const result = await api.skillsInstall(skill.id);
      if (result.ok) {
        installedIds.add(installKey);
        // The main-process command caches are cleared by the install handler, but
        // the renderer's cached `pluginCommands` (which feeds the slash menu) is
        // only refreshed on agent/dir switches. Without this, a skill installed
        // while the agent stays put — notably Claude, whose skills are sourced
        // live — isn't discoverable until the next switch. Re-fetch now.
        const cwd =
          workspace.activeSession?.run.workingDirectory ??
          workspace.globalDefaults.workingDirectory;
        const activeTabId = workspace.activeTabId;
        const activeServerId =
          (activeTabId ? workspace.runFor(activeTabId)?.serverId : undefined) ??
          serverConnections.defaultServerId();
        if (activeServerId === serverId) {
          void workspace.refreshPluginCommands(cwd, activeTabId || undefined);
        }
      } else {
        installErrors.set(installKey, result.error || "Install failed");
      }
    } catch (err) {
      installErrors.set(
        installKey,
        err instanceof Error ? err.message : "Install failed",
      );
    } finally {
      installing.delete(installKey);
      searchEl?.focus();
    }
  }
</script>

{#if capabilities === undefined}
  <div class="py-10 text-center text-sm text-(--solus-text-tertiary)" role="status">
    Checking skill support…
  </div>
{:else if !isSupported}
  <SettingsHostUnsupported feature="Skills" {hostLabel} />
{:else}
<div>
  <!-- Row flex, not column: SearchField's `basis-56` sizes the main axis, so a
       column parent would stretch the field to 14rem tall. -->
  <div class="flex items-center">
    <SearchField
      bind:ref={searchEl}
      bind:value={query}
      onkeydown={onKeydown}
      placeholder="Search skills.sh…"
      class="rounded-md py-1 [&_input]:text-xs"
    />
  </div>
  {#if activeAgentLabels.length > 0}
    <p class="mt-2 px-0.5 text-xs text-(--solus-text-tertiary)">
      Installs into: {activeAgentLabels.join(", ")}
    </p>
  {/if}
</div>

<SettingsSection label="Results">
  {#if searching && results.length === 0}
    <div class="flex items-center justify-center gap-2 py-10 text-sm text-(--solus-text-tertiary)">
      <SpinnerGapIcon size={15} class="animate-spin" />
      Searching skills.sh…
    </div>
  {:else if hasSearched && results.length === 0}
    <div class="py-10 text-center text-sm text-(--solus-text-tertiary)">
      No skills found for "{query.trim()}"
    </div>
  {:else if !hasSearched}
    <div class="py-10 text-center text-sm text-(--solus-text-tertiary)">
      Type to search the skills registry
    </div>
  {:else}
    {#each visibleResults as skill (skill.id)}
      {@const installKey = hostKey(serverId, skill.id)}
      {@const isInstalled = installedIds.has(installKey)}
      {@const isInstalling = installing.has(installKey)}
      {@const error = installErrors.get(installKey)}
      {#snippet installError()}
        <div class="flex items-center gap-1 text-xs text-(--solus-status-error)">
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
              onclick={(e) => { e.preventDefault(); localApi.openExternal(skill.url); }}
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
              class="flex items-center gap-[0.3125rem] px-3 py-1.5 text-sm font-medium text-(--solus-accent)"
              data-testid="skill-installed"
            >
              <CheckIcon size={13} weight="bold" />
              Installed
            </span>
          {:else}
            <Button
              size="sm"
              onclick={() => install(skill)}
              disabled={isInstalling || !canInstall}
              title={!canInstall ? `Skill installation is not supported on ${hostLabel}.` : undefined}
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
{/if}
