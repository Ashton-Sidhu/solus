<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { getWorkspaceContext } from "../../contexts";
  import { settingsSection } from "./lib/settings-section-loaders";
  import SettingsSectionSkeleton from "./SettingsSectionSkeleton.svelte";

  let {
    pageQuery,
    selectedSettingsHost,
    selectedSettingsApi,
    scopeControl,
  }: {
    pageQuery: string;
    selectedSettingsHost: { serverId: string; label: string } | null;
    selectedSettingsApi: HostApi | null;
    scopeControl: Snippet;
  } = $props();

  const session = getWorkspaceContext();
</script>

{#snippet loading()}
  <!-- Hidden for its first 150 ms, so a section that loads fast shows no skeleton. -->
  <div role="status" aria-label="Loading settings section" class="animate-in fade-in fill-mode-backwards duration-200 delay-150">
    <SettingsSectionSkeleton />
  </div>
{/snippet}

{#snippet loadError()}
  <p role="alert" class="text-workspace-chrome text-muted-foreground">Could not load this section. Reload Solus and try again.</p>
{/snippet}

{#if session.settingsTab === "source-control" && selectedSettingsHost && selectedSettingsApi}
  <div class="flex flex-col gap-5">
    {@render scopeControl()}
    {#await settingsSection("source-control")}
      {@render loading()}
    {:then { default: SettingsTabSourceControl }}
      <SettingsTabSourceControl
        searchQuery={pageQuery}
        serverId={selectedSettingsHost.serverId}
        api={selectedSettingsApi}
        projectCwd={session.settingsProjectCwd}
      />
    {:catch}
      {@render loadError()}
    {/await}
  </div>
{:else if session.settingsTab === "general" && selectedSettingsHost && selectedSettingsApi}
  {#await settingsSection("general")}
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
  {#await settingsSection("chat")}
    {@render loading()}
  {:then { default: SettingsTabChat }}
    <SettingsTabChat searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "sessions"}
  {#await settingsSection("sessions")}
    {@render loading()}
  {:then { default: SettingsTabSessions }}
    <SettingsTabSessions searchQuery={pageQuery} serverId={selectedSettingsHost?.serverId} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "account"}
  {#await settingsSection("account")}
    {@render loading()}
  {:then { default: SettingsTabAccount }}
    <SettingsTabAccount searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "agent-profile"}
  {#await settingsSection("agent-profile")}
    {@render loading()}
  {:then { default: SettingsTabAgentProfile }}
    <SettingsTabAgentProfile searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "organization"}
  {#await settingsSection("organization")}
    {@render loading()}
  {:then { default: SettingsTabOrganization }}
    <SettingsTabOrganization searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "policy"}
  {#await settingsSection("policy")}
    {@render loading()}
  {:then { default: PolicyPage }}
    <PolicyPage searchQuery={pageQuery} serverId={selectedSettingsHost?.serverId ?? null} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "host" && selectedSettingsHost}
  {#await settingsSection("host")}
    {@render loading()}
  {:then { default: SettingsTabHost }}
    <SettingsTabHost searchQuery={pageQuery} serverId={selectedSettingsHost.serverId} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "appearance"}
  {#await settingsSection("appearance")}
    {@render loading()}
  {:then { default: SettingsTabAppearance }}
    <SettingsTabAppearance searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "notifications"}
  {#await settingsSection("notifications")}
    {@render loading()}
  {:then { default: SettingsTabNotifications }}
    <SettingsTabNotifications searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "review"}
  {#await settingsSection("review")}
    {@render loading()}
  {:then { default: SettingsTabReview }}
    <SettingsTabReview searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "voice"}
  {#if selectedSettingsHost && selectedSettingsApi}
    {#await settingsSection("voice")}
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
    {#await settingsSection("voiceDictionary")}
      {@render loading()}
    {:then { default: VoiceDictionaryField }}
      <VoiceDictionaryField />
    {:catch}
      {@render loadError()}
    {/await}
  {/if}
{:else if session.settingsTab === "telemetry"}
  {#await settingsSection("analytics")}
    {@render loading()}
  {:then { default: AnalyticsSettings }}
    <AnalyticsSettings searchQuery={pageQuery} host={selectedSettingsHost} />
  {:catch}
    {@render loadError()}
  {/await}
  {#if selectedSettingsHost && selectedSettingsApi}
    {#await settingsSection("telemetry")}
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
  {#await settingsSection("experimental")}
    {@render loading()}
  {:then { default: SettingsTabExperimental }}
    <SettingsTabExperimental searchQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "providers"}
  {#await settingsSection("providers")}
    {@render loading()}
  {:then { default: SettingsTabProviders }}
    <SettingsTabProviders serverId={selectedSettingsHost?.serverId} projectCwd={session.settingsProjectCwd} {scopeControl} />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "api-access"}
  {#await settingsSection("api-access")}
    {@render loading()}
  {:then { default: ConnectionsPanel }}
    <ConnectionsPanel />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "tools" && selectedSettingsHost && selectedSettingsApi}
  {#await settingsSection("tools")}
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
    {#await settingsSection("integrations")}
      {@render loading()}
    {:then { default: IntegrationAccounts }}
      <IntegrationAccounts serverId={selectedSettingsHost.serverId} />
    {:catch}
      {@render loadError()}
    {/await}
  {/key}
{:else if session.settingsTab === "mcp" && selectedSettingsHost}
  {#key selectedSettingsHost.serverId}
    {#await settingsSection("mcp")}
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
  {#await settingsSection("skills")}
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
    {#await settingsSection("devices")}
      {@render loading()}
    {:then { default: DeviceSettings }}
      <DeviceSettings serverId={selectedSettingsHost.serverId} />
    {:catch}
      {@render loadError()}
    {/await}
  {/key}
{:else if session.settingsTab === "webhooks"}
  {#await settingsSection("webhooks")}
    {@render loading()}
  {:then { default: SettingsTabWebhooks }}
    <SettingsTabWebhooks />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "codebases"}
  {#await settingsSection("codebases")}
    {@render loading()}
  {:then { default: SettingsTabCodebases }}
    <SettingsTabCodebases />
  {:catch}
    {@render loadError()}
  {/await}
{:else if session.settingsTab === "keybindings"}
  {#await settingsSection("keybindings")}
    {@render loading()}
  {:then { default: SettingsTabKeybindings }}
    <SettingsTabKeybindings settingsQuery={pageQuery} />
  {:catch}
    {@render loadError()}
  {/await}
{/if}
