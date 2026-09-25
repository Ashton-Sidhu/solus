<script lang="ts">
  import { getSettingsContext } from "../../contexts";
  import { Switch } from "../ui/switch";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const settings = getSettingsContext();
  const settingItems = [
    { id: "auto-voice", keywords: ["voice", "dictation", "automatic", "listen", "beta"] },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return settingItems.find((item) => item.id === id)?.keywords.some((keyword) => keyword.includes(query)) ?? true;
  }

  const anyVisible = $derived(settingItems.some((item) => isVisible(item.id)));
</script>

<SettingsSection
  label="Voice"
  visible={isVisible("auto-voice")}
>
  <SettingsRow
    label="Auto voice mode"
    description="Always listen and queue voice messages (⌥⇧V)."
    visible={isVisible("auto-voice")}
  >
    {#snippet control()}
      <Switch
        checked={settings.voiceModeEnabled}
        onCheckedChange={(enabled) => settings.update({ voiceModeEnabled: enabled })}
        size="default"
        aria-label="Toggle auto voice mode"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:py-6">
    No settings match your search
  </div>
{/if}
