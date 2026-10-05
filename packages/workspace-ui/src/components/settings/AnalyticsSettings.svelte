<script lang="ts">
  /** Anonymous usage analytics, on the Telemetry page with the rest of the data
   *  Solus sends out. Two emitters, two choices: this app's own (a device
   *  setting that never syncs) and the selected host's server (a host setting).
   *  Neither changes the other. */
  import { getSettingsContext } from "../../contexts";
  import { hostSettingsStore } from "../../contexts/app/host-settings.store.svelte";
  import { Switch } from "../ui/switch";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  let { host, searchQuery = "" }: { host: { serverId: string; label: string } | null; searchQuery?: string } = $props();
  const settings = getSettingsContext();
  const hostState = $derived(host ? hostSettingsStore.states.get(host.serverId) : undefined);
  const matches = (words: string[]) => !searchQuery || words.some((word) => word.includes(searchQuery.toLowerCase()));
</script>

<SettingsSection label="Usage analytics" visible={matches(["analytics", "telemetry", "tracking", "privacy", "data", "consent", "usage"])}>
  <SettingsRow
    label="Share anonymous analytics from this device"
    description={settings.clientAnalyticsEnabled === null
      ? "Off until you choose. Saved on this device only."
      : "Anonymous usage data from this app. Saved on this device only."}
  >
    {#snippet control()}
      <Switch
        checked={settings.clientAnalyticsEnabled === true}
        onCheckedChange={(next) => settings.setClientAnalyticsEnabled(next)}
        size="default"
        aria-label="Share anonymous analytics from this device"
      />
    {/snippet}
  </SettingsRow>
  {#if host}
    <SettingsRow
      label="Share anonymous analytics from {host.label}"
      bodyVisible={!!hostState?.error}
      description="Anonymous usage data from the Solus server on this host. Applies to everyone who uses it."
    >
      {#snippet control()}
        <Switch
          checked={hostState?.analyticsEnabled === true}
          disabled={!hostState || hostState.saving}
          onCheckedChange={(next) => void hostSettingsStore.setHostAnalyticsEnabled(host.serverId, next)}
          size="default"
          aria-label="Share anonymous analytics from {host.label}"
        />
      {/snippet}
      {#snippet body()}
        <p class="text-xs text-destructive" role="alert">{hostState?.error}</p>
      {/snippet}
    </SettingsRow>
  {/if}
</SettingsSection>
