<script lang="ts">
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Switch } from "../ui/switch";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const settings = getSettingsContext();
  const settingItems = [
    { id: "stacked-prs", keywords: ["pull request", "pr", "stack", "stacked", "lineage", "parent", "branch"] },
    { id: "auto-voice", keywords: ["voice", "dictation", "automatic", "listen", "beta"] },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return settingItems.find((item) => item.id === id)?.keywords.some((keyword) => keyword.includes(query)) ?? true;
  }

  const anyVisible = $derived(settingItems.some((item) => isVisible(item.id)));
</script>

<SettingsSection label="Pull requests" visible={isVisible("stacked-prs")}>
  <SettingsRow
    label="Stacked pull requests"
    description="Detect pull request lineage and group dependent branches into stacks."
    visible={isVisible("stacked-prs")}
  >
    {#snippet control()}
      <Switch
        checked={settings.stackedPrsEnabled}
        onCheckedChange={(enabled) => {
          settings.update({ stackedPrsEnabled: enabled });
          requestInputFocus();
        }}
        aria-label="Enable stacked pull requests"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  label="Voice"
  visible={isVisible("auto-voice")}
>
  <SettingsRow
    label="Auto voice mode"
    description="Continuously listen and queue voice messages while you work (⌥⇧V)."
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
  <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
    No settings match your search
  </div>
{/if}
