<script lang="ts">
  /** Theme and type: device-local, so no host frame — the same choice follows
   *  this client to every host it connects to. */
  import {
    APP_FONT_FAMILIES,
    APP_CODE_FONT_FAMILIES,
    DOCUMENT_FONT_FAMILIES,
    PROMPT_FONT_FAMILIES,
    IS_MAC_OS,
  } from "../../contexts/app/settings.context.svelte";
  import { getSettingsContext } from "../../contexts";
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

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
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
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));

  // The two-font view by default; Advanced reveals the per-surface overrides.
  // A search reveals them too, so a hit on "prompt" has a row to land on.
  const showAdvanced = $derived(theme.typographyAdvanced || searchQuery.length > 0);
</script>

<SettingsSection label="Theme" visible={isVisible("theme")} plain>
  <ThemeModeTiles
    value={theme.themeMode}
    onSelect={(mode) => theme.update({ themeMode: mode })}
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
        onCheckedChange={(next) => theme.update({ typographyAdvanced: next })}
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
        onSelect={(value) => theme.update({ fontFamily: value })}
        ariaLabel="Interface font"
      />
      <FontSizeSelect
        value={theme.fontSize}
        min={10}
        max={24}
        ariaLabel="Interface font size"
        onChange={(fontSize) => theme.update({ fontSize })}
      />
    {/snippet}
    {#snippet body()}
      <InterfaceFontPreview />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Prompt font"
    description="Only the box you write prompts in. Mono works well here."
    visible={showAdvanced && (isVisible("prompt-font-family") || isVisible("prompt-font-size"))}
  >
    {#snippet control()}
      <FontFamilyPicker
        presets={PROMPT_FONT_FAMILIES}
        value={theme.promptFontFamily}
        onSelect={(value) => theme.update({ promptFontFamily: value })}
        ariaLabel="Prompt font"
      />
      <FontSizeSelect
        value={theme.promptFontSize}
        min={10}
        max={24}
        ariaLabel="Prompt font size"
        onChange={(promptFontSize) => theme.update({ promptFontSize })}
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
        onSelect={(value) => theme.update({ documentFontFamily: value })}
        ariaLabel="Document font"
      />
      <FontSizeSelect
        value={theme.documentFontSize}
        min={12}
        max={28}
        ariaLabel="Document font size"
        onChange={(documentFontSize) => theme.update({ documentFontSize })}
      />
    {/snippet}
    {#snippet body()}
      <DocumentFontPreview />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Code font"
    description="Monospace typeface used in diffs and code blocks."
    visible={isVisible("code-font-family") || isVisible("code-font-size")}
  >
    {#snippet control()}
      <FontFamilyPicker
        presets={codeFontPresets}
        value={theme.codeFontFamily}
        onSelect={(value) => theme.update({ codeFontFamily: value })}
        ariaLabel="Code font"
        requireMonospace
      />
      <FontSizeSelect
        value={theme.codeFontSize}
        min={8}
        max={20}
        ariaLabel="Code font size"
        onChange={(codeFontSize) => theme.update({ codeFontSize })}
      />
    {/snippet}
    {#snippet body()}
      <CodeFontPreview />
    {/snippet}
  </SettingsRow>

  <!-- Only macOS engines honor -webkit-font-smoothing, so the switch would be
       inert anywhere else. -->
  <SettingsRow
    label="Font smoothing"
    description="Use thinner grayscale text smoothing instead of the macOS default."
    visible={showAdvanced && IS_MAC_OS && isVisible("font-smoothing")}
  >
    {#snippet control()}
      <Switch
        checked={theme.fontSmoothing}
        onCheckedChange={(next) => theme.update({ fontSmoothing: next })}
        size="default"
        aria-label="Font smoothing"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div
    class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:py-6"
  >
    No settings match your search
  </div>
{/if}
