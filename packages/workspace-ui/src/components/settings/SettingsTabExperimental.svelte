<script lang="ts">
  import { settingVisible } from "@solus/client-core/settings-search";
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { experimentalSettings as settingItems } from "./lib/settings-search-data";
  import { getSettingsContext } from "../../contexts";
  import { Switch } from "../ui/switch";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const settings = getSettingsContext();

  const isVisible = (id: string) => settingVisible(searchQuery, settingItems, id);

  const anyVisible = $derived(settingItems.some((item) => isVisible(item.id)));
</script>

<SettingsSection
  {...settingsDefinitions["experimental.section-voice"]}
  visible={isVisible("auto-voice")}
>
  <SettingsRow
    {...settingsDefinitions["experimental.auto-voice"]}
    description={`Always listen and queue voice messages (${comboHint("voice.toggle-mode")}).`}
    visible={isVisible("auto-voice")}
  >
    {#snippet control()}
      <Switch
        checked={settings.voiceModeEnabled}
        onCheckedChange={(enabled) => settings.setDevice("voiceModeEnabled", enabled)}
        size="default"
        aria-label="Toggle auto voice mode"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary)">
    No settings match your search
  </div>
{/if}
