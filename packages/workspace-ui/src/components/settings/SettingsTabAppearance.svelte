<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export interface SettingItem {
    id: string;
    keywords: string[];
  }

  export const settingItems: SettingItem[] = [
    {
      id: "theme",
      keywords: ["dark", "theme", "light", "appearance", "mode", "system"],
    },
    {
      id: "font-family",
      keywords: [
        "font",
        "family",
        "typeface",
        "inter",
        "dm sans",
        "system",
        "geist",
        "lora",
        "serif",
      ],
    },
    { id: "font-size", keywords: ["font", "size", "text", "zoom"] },
    {
      id: "reply-opacity",
      keywords: ["reply", "assistant", "message", "text", "opacity", "contrast", "fade", "transcript"],
    },
    {
      id: "font-smoothing",
      keywords: ["font", "smoothing", "antialiased", "grayscale", "thin", "macos"],
    },
    {
      id: "prompt-font-family",
      keywords: [
        "prompt",
        "composer",
        "input",
        "draft",
        "font",
        "family",
        "typeface",
        "mono",
      ],
    },
    {
      id: "prompt-font-size",
      keywords: ["prompt", "composer", "input", "draft", "font", "size"],
    },
    {
      id: "document-font-family",
      keywords: [
        "document",
        "plan",
        "editor",
        "font",
        "family",
        "typeface",
        "writing",
        "prose",
      ],
    },
    {
      id: "document-font-size",
      keywords: [
        "document",
        "plan",
        "editor",
        "font",
        "size",
        "writing",
        "prose",
      ],
    },
    {
      id: "code-font-family",
      keywords: [
        "code",
        "font",
        "mono",
        "monospace",
        "diff",
        "typeface",
        "sf mono",
        "geist",
        "fira",
        "jetbrains",
        "cascadia",
      ],
    },
    {
      id: "code-font-size",
      keywords: ["code", "font", "size", "mono", "diff"],
    },
    {
      id: "installed-fonts",
      keywords: ["font", "installed", "typeface", "override", "synced", "device", "local"],
    },
  ];
</script>

<script lang="ts">
  /** Theme and type are personal: no host frame, and they follow the person to
   *  every host (and every client, with sync on). An installed font is this
   *  device's override; Installed fonts shows it and turns it back. */
  import { FONT_PREFERENCE_KEYS, type FontPreferenceKey } from "@solus/contracts/settings";
  import {
    APP_FONT_FAMILIES,
    APP_CODE_FONT_FAMILIES,
    DOCUMENT_FONT_FAMILIES,
    PROMPT_FONT_FAMILIES,
    IS_MAC_OS,
  } from "../../contexts/app/settings-display";
  import { getSettingsContext } from "../../contexts";
  import { MIN_ASSISTANT_TEXT_OPACITY } from "@solus/contracts/settings";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import FontFamilyPicker from "./FontFamilyPicker.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import ThemeModeTiles from "./ThemeModeTiles.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  // Each font pair (family, then size) closes with the surface it changes, so
  // a choice is judged on the real thing rather than on the picker's label.
  import InterfaceFontPreview from "./InterfaceFontPreview.svelte";
  import PromptFontPreview from "./PromptFontPreview.svelte";
  import DocumentFontPreview from "./DocumentFontPreview.svelte";
  import CodeFontPreview from "./CodeFontPreview.svelte";
  import FontSizeSelect from "./FontSizeSelect.svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();

  // Presets only; the picker adds every installed family behind them.
  const appFontPresets = APP_FONT_FAMILIES.map(({ id, label }) => ({ id, label }));
  const codeFontPresets = APP_CODE_FONT_FAMILIES.map(({ id, label }) => ({ id, label }));


  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const FONT_LABELS = {
    fontFamily: "Interface font",
    codeFontFamily: "Code font",
    documentFontFamily: "Document font",
    promptFontFamily: "Prompt font",
  } as const satisfies Record<FontPreferenceKey, string>;
  const fontPresets: Array<{ id: string; label: string }> = [
    ...APP_FONT_FAMILIES,
    ...APP_CODE_FONT_FAMILIES,
    ...DOCUMENT_FONT_FAMILIES,
    ...PROMPT_FONT_FAMILIES,
  ];
  const presetLabel = (id: string) => fontPresets.find((preset) => preset.id === id)?.label ?? id;
  const fontOverrides = $derived(
    FONT_PREFERENCE_KEYS.flatMap((key) => {
      const family = theme.fontOverrideOf(key);
      return family ? [{ key, family, synced: theme.syncedFontOf(key) }] : [];
    }),
  );

  function useSyncedFont(key: FontPreferenceKey) {
    theme.useSyncedFont(key);
    requestInputFocus();
  }

  const anyVisible = $derived(
    settingItems.some((s) => s.id !== "installed-fonts" && isVisible(s.id)) ||
      (fontOverrides.length > 0 && isVisible("installed-fonts")),
  );

  // The two-font view by default; Advanced reveals the per-surface overrides.
  // A search reveals them too, so a hit on "prompt" has a row to land on.
  const showAdvanced = $derived(theme.typographyAdvanced || searchQuery.length > 0);
</script>

<SettingsSection label="Theme" visible={isVisible("theme")} plain>
  <ThemeModeTiles
    value={theme.themeMode}
    onSelect={(mode) => theme.setPersonal("themeMode", mode)}
  />
</SettingsSection>

<SettingsSection
  label="Typography"
  visible={[
    "font-family",
    "font-size",
    "prompt-font-family",
    "prompt-font-size",
    "document-font-family",
    "document-font-size",
    "code-font-family",
    "code-font-size",
    "reply-opacity",
    "font-smoothing",
  ].some(isVisible)}
>
  {#snippet action()}
    <label
      class="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground"
    >
      Advanced
      <Switch
        checked={theme.typographyAdvanced}
        onCheckedChange={(next) => theme.setLayout("typographyAdvanced", next)}
        size="sm"
        aria-label="Show advanced typography settings"
      />
    </label>
  {/snippet}

  <SettingsRow
    label="Interface font"
    description="Everything outside code blocks and diffs."
    visible={isVisible("font-family") || isVisible("font-size")}
  >
    {#snippet control()}
      <FontFamilyPicker
        presets={appFontPresets}
        value={theme.fontFamily}
        onSelect={(value) => theme.setFont("fontFamily", value)}
        ariaLabel="Interface font"
      />
      <FontSizeSelect
        value={theme.fontSize}
        min={10}
        max={24}
        ariaLabel="Interface font size"
        onChange={(fontSize) => theme.setPersonal("fontSize", fontSize)}
      />
    {/snippet}
    {#snippet body()}
      <InterfaceFontPreview />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Prompt font"
    description="The prompt box only. Mono works well."
    visible={showAdvanced && (isVisible("prompt-font-family") || isVisible("prompt-font-size"))}
  >
    {#snippet control()}
      <FontFamilyPicker
        presets={PROMPT_FONT_FAMILIES}
        value={theme.promptFontFamily}
        onSelect={(value) => theme.setFont("promptFontFamily", value)}
        ariaLabel="Prompt font"
      />
      <FontSizeSelect
        value={theme.promptFontSize}
        min={10}
        max={24}
        ariaLabel="Prompt font size"
        onChange={(promptFontSize) => theme.setPersonal("promptFontSize", promptFontSize)}
      />
    {/snippet}
    {#snippet body()}
      <PromptFontPreview />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Document font"
    description="Document and plan editors."
    visible={showAdvanced &&
      (isVisible("document-font-family") || isVisible("document-font-size"))}
  >
    {#snippet control()}
      <FontFamilyPicker
        presets={DOCUMENT_FONT_FAMILIES}
        value={theme.documentFontFamily}
        onSelect={(value) => theme.setFont("documentFontFamily", value)}
        ariaLabel="Document font"
      />
      <FontSizeSelect
        value={theme.documentFontSize}
        min={12}
        max={28}
        ariaLabel="Document font size"
        onChange={(documentFontSize) => theme.setPersonal("documentFontSize", documentFontSize)}
      />
    {/snippet}
    {#snippet body()}
      <DocumentFontPreview />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Code font"
    description="Diffs and code blocks."
    visible={isVisible("code-font-family") || isVisible("code-font-size")}
  >
    {#snippet control()}
      <FontFamilyPicker
        presets={codeFontPresets}
        value={theme.codeFontFamily}
        onSelect={(value) => theme.setFont("codeFontFamily", value)}
        ariaLabel="Code font"
        requireMonospace
      />
      <FontSizeSelect
        value={theme.codeFontSize}
        min={8}
        max={20}
        ariaLabel="Code font size"
        onChange={(codeFontSize) => theme.setPersonal("codeFontSize", codeFontSize)}
      />
    {/snippet}
    {#snippet body()}
      <CodeFontPreview />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Reply text opacity"
    description="How strong the agent's reply text reads. Headings stay at full strength."
    visible={isVisible("reply-opacity")}
  >
    {#snippet control()}
      <input
        type="range"
        min={MIN_ASSISTANT_TEXT_OPACITY}
        max={100}
        step={5}
        value={theme.assistantTextOpacity}
        oninput={(event) => theme.setPersonal("assistantTextOpacity", event.currentTarget.valueAsNumber)}
        class="w-32 cursor-pointer accent-(--primary)"
        aria-label="Reply text opacity"
      />
      <span class="w-10 text-right text-xs tabular-nums text-muted-foreground">{theme.assistantTextOpacity}%</span>
    {/snippet}
  </SettingsRow>

  <!-- Only macOS engines honor -webkit-font-smoothing, so the switch would be
       inert anywhere else. -->
  <SettingsRow
    label="Font smoothing"
    description="Thinner grayscale smoothing than the macOS default."
    visible={showAdvanced && IS_MAC_OS && isVisible("font-smoothing")}
  >
    {#snippet control()}
      <Switch
        checked={theme.fontSmoothing}
        onCheckedChange={(next) => theme.setDevice("fontSmoothing", next)}
        size="default"
        aria-label="Font smoothing"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<!-- Only when a font installed on this device masks a synced choice. -->
<SettingsSection
  label="Installed fonts"
  description="A font installed on this device stays here. Other devices keep your synced choice."
  visible={fontOverrides.length > 0 && isVisible("installed-fonts")}
>
  {#each fontOverrides as override (override.key)}
    <SettingsRow
      label={FONT_LABELS[override.key]}
      description="{override.family} on this device. Your synced choice is {presetLabel(override.synced)}."
    >
      {#snippet control()}
        <Button variant="outline" size="sm" onclick={() => useSyncedFont(override.key)}>Use synced font</Button>
      {/snippet}
    </SettingsRow>
  {/each}
</SettingsSection>

{#if !anyVisible}
  <div
    class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary)"
  >
    No settings match your search
  </div>
{/if}
