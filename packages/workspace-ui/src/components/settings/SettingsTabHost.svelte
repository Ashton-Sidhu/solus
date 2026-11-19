<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  /** The selected host's own settings: they apply to all work on that machine
   *  and to everyone who uses it. Choosing another host here changes none of
   *  your personal settings. Its analytics consent is on Telemetry. */
  import SettingsSection from "./SettingsSection.svelte";
  import RetentionSetting from "./RetentionSetting.svelte";
  import SessionCloudSyncSetting from "./SessionCloudSyncSetting.svelte";
  import WebhookHostSettings from "../webhooks/WebhookHostSettings.svelte";
  import AppHostSettings from "../app/AppHostSettings.svelte";
  import { appHostSearchWords, retentionSearchWords, webhookHostSearchWords } from "./lib/settings-search-data";
  import { hostLock } from "./policy/managed-setting.svelte";
  import { automationRetentionStore, recordingRetentionStore } from "../../contexts/hosts/host-retention.store.svelte";

  let { serverId, searchQuery = "" }: { serverId: string; searchQuery?: string } = $props();
  const matches = (words: string[]) => !searchQuery || words.some((word) => word.includes(searchQuery.toLowerCase()));
</script>

<SettingsSection label="Cloud sessions" description="Control what this host saves to your account." visible={matches(["cloud", "sessions", "sync", "conversation"])}>
  <SessionCloudSyncSetting {serverId} />
</SettingsSection>

<SettingsSection {...settingsDefinitions["host.section-retention"]} visible={matches(retentionSearchWords)}>
  <RetentionSetting
    {serverId}
    store={automationRetentionStore}
    {...settingsDefinitions["host.delete-archived-automations-after"]}
    inputLabel="Archived automation retention in days"
    managed={hostLock(serverId, "archivedAutomationRetentionDays")}
  />
  <RetentionSetting
    {serverId}
    store={recordingRetentionStore}
    {...settingsDefinitions["host.delete-unfiled-recordings-after"]}
    inputLabel="Unfiled recording retention in days"
    managed={hostLock(serverId, "unfiledRecordingRetentionDays")}
  />
</SettingsSection>

{#key serverId}
  <WebhookHostSettings {serverId} visible={matches(webhookHostSearchWords)} />
  <AppHostSettings {serverId} visible={matches(appHostSearchWords)} />
{/key}
