<script lang="ts">
  /** This device: what stays here and never syncs — installed fonts that mask a
   *  synced choice. This device's analytics consent is on Telemetry. Editors and
   *  terminals are in Tools; zoom, panes, and shortcuts are this device's too. */
  import { FONT_PREFERENCE_KEYS, type FontPreferenceKey } from "@solus/contracts/settings";
  import { getSettingsContext } from "../../contexts";
  import {
    APP_CODE_FONT_FAMILIES,
    APP_FONT_FAMILIES,
    DOCUMENT_FONT_FAMILIES,
    PROMPT_FONT_FAMILIES,
  } from "../../contexts/app/settings-display";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  let { searchQuery = "" }: { searchQuery?: string } = $props();
  const settings = getSettingsContext();

  const FONT_LABELS = {
    fontFamily: "Interface font",
    codeFontFamily: "Code font",
    documentFontFamily: "Document font",
    promptFontFamily: "Prompt font",
  } as const satisfies Record<FontPreferenceKey, string>;
  const presets: Array<{ id: string; label: string }> = [
    ...APP_FONT_FAMILIES,
    ...APP_CODE_FONT_FAMILIES,
    ...DOCUMENT_FONT_FAMILIES,
    ...PROMPT_FONT_FAMILIES,
  ];
  const presetLabel = (id: string) => presets.find((preset) => preset.id === id)?.label ?? id;
  const overrides = $derived(
    FONT_PREFERENCE_KEYS.flatMap((key) => {
      const family = settings.fontOverrideOf(key);
      return family ? [{ key, family, synced: settings.syncedFontOf(key) }] : [];
    }),
  );

  function useSyncedFont(key: FontPreferenceKey) {
    settings.useSyncedFont(key);
    requestInputFocus();
  }

  const matches = (words: string[]) => !searchQuery || words.some((word) => word.includes(searchQuery.toLowerCase()));
</script>

<SettingsSection
  label="Installed fonts"
  description="A font installed on this device stays here. Other devices keep your synced choice."
  visible={matches(["font", "installed", "typeface", "override", "synced"])}
>
  {#each overrides as override (override.key)}
    <SettingsRow
      label={FONT_LABELS[override.key]}
      description="{override.family} on this device. Your synced choice is {presetLabel(override.synced)}."
    >
      {#snippet control()}
        <Button variant="outline" size="sm" onclick={() => useSyncedFont(override.key)}>Use synced font</Button>
      {/snippet}
    </SettingsRow>
  {:else}
    <SettingsRow label="Synced fonts" description="This device uses your synced fonts. Choose an installed font in Appearance to use it here only." />
  {/each}
</SettingsSection>
