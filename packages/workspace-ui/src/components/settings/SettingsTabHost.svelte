<script lang="ts">
  /** The selected host's own settings: they apply to all work on that machine
   *  and to everyone who uses it. Choosing another host here changes none of
   *  your personal settings. Its analytics consent is on Telemetry. */
  import SettingsSection from "./SettingsSection.svelte";
  import AutomationRetentionSetting from "./AutomationRetentionSetting.svelte";

  let { serverId, searchQuery = "" }: { serverId: string; searchQuery?: string } = $props();
  const matches = (words: string[]) => !searchQuery || words.some((word) => word.includes(searchQuery.toLowerCase()));
</script>

<SettingsSection label="Retention" visible={matches(["automation", "archived", "delete", "retention", "days", "history"])}>
  <AutomationRetentionSetting {serverId} />
</SettingsSection>
