<script lang="ts">
  /** The selected host's own settings: they apply to all work on that machine
   *  and to everyone who uses it. Choosing another host here changes none of
   *  your personal settings. Its analytics consent is on Telemetry. */
  import SettingsSection from "./SettingsSection.svelte";
  import RetentionSetting from "./RetentionSetting.svelte";
  import WebhookHostSettings from "../webhooks/WebhookHostSettings.svelte";
  import { hostLock } from "./policy/managed-setting.svelte";
  import { automationRetentionStore, recordingRetentionStore } from "../../contexts/hosts/host-retention.store.svelte";

  let { serverId, searchQuery = "" }: { serverId: string; searchQuery?: string } = $props();
  const matches = (words: string[]) => !searchQuery || words.some((word) => word.includes(searchQuery.toLowerCase()));
</script>

<SettingsSection label="Retention" visible={matches(retentionWords)}>
  <RetentionSetting
    {serverId}
    store={automationRetentionStore}
    label="Delete archived automations after"
    description="Days to keep archived automations and their runs. Conversations are kept."
    inputLabel="Archived automation retention in days"
    managed={hostLock(serverId, "archivedAutomationRetentionDays")}
  />
  <RetentionSetting
    {serverId}
    store={recordingRetentionStore}
    label="Delete unfiled recordings after"
    description="Days to keep a browser recording that is not filed on a task or pull request, or sent to an agent."
    inputLabel="Unfiled recording retention in days"
    managed={hostLock(serverId, "unfiledRecordingRetentionDays")}
  />
</SettingsSection>

{#key serverId}
  <WebhookHostSettings {serverId} visible={matches(webhookWords)} />
{/key}
