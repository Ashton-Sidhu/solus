<script lang="ts">
  /**
   * Settings → Providers: the agent harnesses a session on this host runs
   * through, Claude Code and Codex. The owner manages the host login; an
   * organization member manages their own seat instead
   * (docs/plans/provider-seats.md §3.6).
   */
  import type { Snippet } from "svelte";
  import ProjectProviderSettings from "./ProjectProviderSettings.svelte";
  import ProviderInstancesSettings from "./ProviderInstancesSettings.svelte";
  import { PROVIDERS } from "@solus/contracts/provider-model-settings";
  import ProviderModelSettings from "./ProviderModelSettings.svelte";
  import { MODEL_PROFILES, type AgentId } from "@solus/contracts/types";
  import { ArrowLeft, ChevronRight } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import ProviderLogo from "../servers/ProviderLogo.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import { untrack } from "svelte";
  import { seatsStore, getSettingsContext } from "../../contexts";
  import { usesCloudAgentSeats } from "../../contexts/seats/cloud-agent-seats.store.svelte";
  import SeatsSettings from "../seats/SeatsSettings.svelte";
  import ProviderPanel from "../servers/ProviderPanel.svelte";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";

  interface Props {
    serverId?: string;
    projectCwd?: string | null;
    scopeControl?: Snippet;
  }

  let { serverId, projectCwd, scopeControl }: Props = $props();
  const settings = getSettingsContext();
  let selectedProvider = $state<AgentId | null>(null);
  const providerDetail = $derived(PROVIDERS.find((provider) => provider.id === selectedProvider));

  const setup = $derived(serverId ? hostSetupStore.sessionFor(serverId) : null);
  const hasSeats = $derived(!!serverId && (usesCloudAgentSeats(serverId) || seatsStore.hasSeats.get(serverId) === true));

  // Setup events belong to the host, so the page holds its subscription open
  // while it shows that host, and hands it back on the way out.
  $effect(() => {
    const targetServerId = serverId;
    if (!targetServerId) return;
    return untrack(() => {
      const session = hostSetupStore.sessionFor(targetServerId);
      session.retain();
      void session.refreshReadiness();
      return () => session.release();
    });
  });
</script>

{#if projectCwd && serverId}
  <div class="flex flex-col gap-5">
    {@render scopeControl?.()}
    <ProjectProviderSettings {serverId} cwd={projectCwd} />
  </div>
{:else if providerDetail}
  <div>
    <Button variant="ghost" size="sm" onclick={() => (selectedProvider = null)}>
      <ArrowLeft size={16} /> All providers
    </Button>
  </div>
  <ProviderModelSettings provider={providerDetail.id} label={providerDetail.label} />
{:else}
  {#if serverId && setup}
    <SeatsSettings {serverId} />
    {#if !hasSeats}<ProviderPanel {setup} />{/if}
  {:else}
    <p class="text-workspace-chrome text-muted-foreground">Connect a host to manage provider installation and sign-in. You can set your model defaults below.</p>
  {/if}
  {#if serverId}
    <div class="flex flex-col gap-5">
      {@render scopeControl?.()}
      <ProviderInstancesSettings {serverId} />
    </div>
  {:else}
  <SettingsSection label="Model defaults">
    {#each PROVIDERS as provider (provider.id)}
      <button type="button" onclick={() => (selectedProvider = provider.id)}
        class="flex w-full min-w-0 items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
        aria-label="{provider.label} model defaults">
        <ProviderLogo provider={provider.id === "claude-code" ? "claude" : "codex"} />
        <span class="min-w-0 flex-1">
          <span class="block text-workspace-chrome text-foreground">{provider.label}</span>
          <span class="block truncate text-sm text-muted-foreground">{settings.defaultModels[provider.id] === "auto" ? "Auto" : settings.defaultModels[provider.id] ? (MODEL_PROFILES[provider.id]?.[settings.defaultModels[provider.id] ?? ""]?.label ?? settings.defaultModels[provider.id]) : "Built-in default"}</span>
        </span>
        <ChevronRight size={16} class="shrink-0 text-muted-foreground" />
      </button>
    {/each}
  </SettingsSection>
  {/if}
  <p class="text-workspace-chrome text-muted-foreground">These model preferences are yours. They follow your account when settings sync is on.</p>
{/if}
