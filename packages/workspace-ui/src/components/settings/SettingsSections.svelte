<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { getWorkspaceContext } from "../../contexts";
  import { settingsSectionLoaders } from "./lib/settings-section-loaders";
  import { Skeleton } from "../ui/skeleton";

  let {
    pageQuery,
    selectedSettingsHost,
    selectedSettingsApi,
    scopeControl,
    setSearchQuery,
  }: {
    pageQuery: string;
    selectedSettingsHost: { serverId: string; label: string } | null;
    selectedSettingsApi: HostApi | null;
    scopeControl: Snippet;
    setSearchQuery: (query: string) => void;
  } = $props();

  const session = getWorkspaceContext();
</script>

{#snippet loading()}
  <div role="status" aria-label="Loading settings section" class="flex flex-col gap-4">
    <Skeleton class="h-5 w-32" />
    <Skeleton class="h-24 w-full rounded-xl" />
    <Skeleton class="h-24 w-full rounded-xl" />
  </div>
{/snippet}

{#snippet loadError()}
  <p role="alert" class="text-workspace-chrome text-muted-foreground">Could not load this section. Reload Solus and try again.</p>
{/snippet}

{#if session.settingsTab === "source-control" && selectedSettingsHost && selectedSettingsApi}
  <div class="flex flex-col gap-5">
    {@render scopeControl()}
    {#await settingsSectionLoaders["source-control"]()}
      {@render loading()}
    {:then { default: SettingsTabSourceControl }}
      <SettingsTabSourceControl
        serverId={selectedSettingsHost.serverId}
        api={selectedSettingsApi}
        projectCwd={session.settingsProjectCwd}
      />
    {:catch}
      {@render loadError()}
    {/await}
  </div>
{:else if session.settingsTab === "general" && selectedSettingsHost && selectedSettingsApi}
  {#await settingsSectionLoaders["general"]()}
    {@render loading()}
  {:then { default: SettingsTabGeneral }}
    <SettingsTabGeneral
      searchQuery={pageQuery}
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "chat"}
  {#await settingsSectionLoaders["chat"]()}
    {@render loading()}
  {:then { default: SettingsTabChat }}
    <SettingsTabChat searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "sessions"}
  {#await settingsSectionLoaders["sessions"]()}
    {@render loading()}
  {:then { default: SettingsTabSessions }}
    <SettingsTabSessions searchQuery={pageQuery} serverId={selectedSettingsHost?.serverId} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "tasks"}
  {#await settingsSectionLoaders["tasks"]()}
    {@render loading()}
  {:then { default: SettingsTabTasks }}
    <SettingsTabTasks searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "account"}
  {#await settingsSectionLoaders["account"]()}
    {@render loading()}
  {:then { default: SettingsTabAccount }}
    <SettingsTabAccount searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "agent-profile"}
  {#await settingsSectionLoaders["agent-profile"]()}
    {@render loading()}
  {:then { default: SettingsTabAgentProfile }}
    <SettingsTabAgentProfile searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "organization"}
  {#await settingsSectionLoaders["organization"]()}
    {@render loading()}
  {:then { default: SettingsTabOrganization }}
    <SettingsTabOrganization searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "policy"}
  {#await settingsSectionLoaders["policy"]()}
    {@render loading()}
  {:then { default: PolicyPage }}
    <PolicyPage searchQuery={pageQuery} serverId={selectedSettingsHost?.serverId ?? null} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "host" && selectedSettingsHost}
  {#await settingsSectionLoaders["host"]()}
    {@render loading()}
  {:then { default: SettingsTabHost }}
    <SettingsTabHost searchQuery={pageQuery} serverId={selectedSettingsHost.serverId} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "appearance"}
  {#await settingsSectionLoaders["appearance"]()}
    {@render loading()}
  {:then { default: SettingsTabAppearance }}
    <SettingsTabAppearance searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "notifications"}
  {#await settingsSectionLoaders["notifications"]()}
    {@render loading()}
  {:then { default: SettingsTabNotifications }}
    <SettingsTabNotifications searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "review"}
  {#await settingsSectionLoaders["review"]()}
    {@render loading()}
  {:then { default: SettingsTabReview }}
    <SettingsTabReview searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "voice"}
  {#if selectedSettingsHost && selectedSettingsApi}
    {#await settingsSectionLoaders["voice"]()}
      {@render loading()}
    {:then { default: SettingsTabVoice }}
      <SettingsTabVoice
        serverId={selectedSettingsHost.serverId}
        hostLabel={selectedSettingsHost.label}
      />
    {:catch}
      {@render loadError()}
    {/await}
  {:else}
    {#await settingsSectionLoaders["voiceDictionary"]()}
      {@render loading()}
    {:then { default: VoiceDictionaryField }}
      <VoiceDictionaryField />
    {:catch}
      {@render loadError()}
    {/await}
  {/if}
{:else if session.settingsTab === "telemetry"}
  {#await settingsSectionLoaders["analytics"]()}
    {@render loading()}
  {:then { default: AnalyticsSettings }}
    <AnalyticsSettings searchQuery={pageQuery} host={selectedSettingsHost} />
  {:catch}
    {@render loadError()}
  {/await}
  {#if selectedSettingsHost && selectedSettingsApi}
    {#await settingsSectionLoaders["telemetry"]()}
      {@render loading()}
    {:then { default: SettingsTabTelemetry }}
      <SettingsTabTelemetry
        searchQuery={pageQuery}
        serverId={selectedSettingsHost.serverId}
        api={selectedSettingsApi}
      />
    {:catch}
      {@render loadError()}
    {/await}
  {/if}
{:else if session.settingsTab === "experimental"}
  {#await settingsSectionLoaders["experimental"]()}
    {@render loading()}
  {:then { default: SettingsTabExperimental }}
    <SettingsTabExperimental searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "providers"}
  {#await settingsSectionLoaders["providers"]()}
    {@render loading()}
  {:then { default: SettingsTabProviders }}
    <SettingsTabProviders serverId={selectedSettingsHost?.serverId} projectCwd={session.settingsProjectCwd} {scopeControl} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "api-access"}
  {#await settingsSectionLoaders["api-access"]()}
    {@render loading()}
  {:then { default: ConnectionsPanel }}
    <ConnectionsPanel />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "tools" && selectedSettingsHost && selectedSettingsApi}
  {#await settingsSectionLoaders["tools"]()}
    {@render loading()}
  {:then { default: SettingsTabTools }}
    <SettingsTabTools
      searchQuery={pageQuery}
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "integrations" && selectedSettingsHost}
  {#key selectedSettingsHost.serverId}
    {#await settingsSectionLoaders["integrations"]()}
      {@render loading()}
    {:then { default: IntegrationAccounts }}
      <IntegrationAccounts serverId={selectedSettingsHost.serverId} />
    {:catch}
      {@render loadError()}
    {/await}
  {/key}
{:else if session.settingsTab === "mcp" && selectedSettingsHost}
  {#key selectedSettingsHost.serverId}
    {#await settingsSectionLoaders["mcp"]()}
      {@render loading()}
    {:then { default: SettingsTabMcp }}
      <SettingsTabMcp
        searchQuery={pageQuery}
        serverId={selectedSettingsHost.serverId}
        hostLabel={selectedSettingsHost.label}
      />
    {:catch}
      {@render loadError()}
    {/await}
  {/key}
{:else if session.settingsTab === "skills" && selectedSettingsHost && selectedSettingsApi}
  {#await settingsSectionLoaders["skills"]()}
    {@render loading()}
  {:then { default: SettingsTabSkills }}
    <SettingsTabSkills
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "devices" && selectedSettingsHost}
  {#key selectedSettingsHost.serverId}
    {#await settingsSectionLoaders["devices"]()}
      {@render loading()}
    {:then { default: DeviceSettings }}
      <DeviceSettings serverId={selectedSettingsHost.serverId} />
    {:catch}
      {@render loadError()}
    {/await}
  {/key}
{:else if session.settingsTab === "webhooks"}
  {#await settingsSectionLoaders["webhooks"]()}
    {@render loading()}
  {:then { default: SettingsTabWebhooks }}
    <SettingsTabWebhooks />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "keybindings"}
  {#await settingsSectionLoaders["keybindings"]()}
    {@render loading()}
  {:then { default: SettingsTabKeybindings }}
    <SettingsTabKeybindings bind:searchQuery={() => pageQuery, setSearchQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{/if}
