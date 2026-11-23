<script lang="ts">
  import { settingVisible } from "@solus/client-core/settings-search";
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { appearanceSettings as settingItems } from "./lib/settings-search-data";
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
  import {
    MAX_SIDEBAR_MOTION_MS,
    MIN_ASSISTANT_TEXT_OPACITY,
    type ConversationWidth,
    type SidebarView,
  } from "@solus/contracts/settings";
  import type { SkySceneChoice } from "../../lib/sky-scene";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import FontFamilyPicker from "./FontFamilyPicker.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import ThemeModeTiles from "./ThemeModeTiles.svelte";
  import ThemeCssField from "./ThemeCssField.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  // Each font pair (family, then size) closes with the surface it changes, so
  // a choice is judged on the real thing rather than on the picker's label.
  import InterfaceFontPreview from "./InterfaceFontPreview.svelte";
  import PromptFontPreview from "./PromptFontPreview.svelte";
  import DocumentFontPreview from "./DocumentFontPreview.svelte";
  import CodeFontPreview from "./CodeFontPreview.svelte";
  import ProjectPanelItemsMenu from "../project-panel/ProjectPanelItemsMenu.svelte";
  import SidebarPlacesMenu from "../session/SidebarPlacesMenu.svelte";
  import { isPlacesLayoutChanged } from "../../lib/sidebar-places";
  import FontSizeSelect from "./FontSizeSelect.svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();

  // Presets only; the picker adds every installed family behind them.
  const appFontPresets = APP_FONT_FAMILIES.map(({ id, label }) => ({ id, label }));
  const codeFontPresets = APP_CODE_FONT_FAMILIES.map(({ id, label }) => ({ id, label }));
  const skySceneChoices: ReadonlyArray<{ value: SkySceneChoice; label: string }> = [
    { value: "auto", label: "Time of day" },
    { value: "dawn", label: "Dawn" },
    { value: "day", label: "Day" },
    { value: "dusk", label: "Dusk" },
    { value: "night", label: "Night" },
  ];
  const sidebarViews: ReadonlyArray<{ value: SidebarView; label: string }> = [
    { value: "status", label: "By status" },
    { value: "project", label: "By project" },
  ];

  let panelItemsMenuOpen = $state(false);
  let panelItemsTrigger = $state<HTMLElement | null>(null);
  let placesMenuOpen = $state(false);
  let placesTrigger = $state<HTMLElement | null>(null);

  const conversationWidths: ReadonlyArray<{ value: ConversationWidth; label: string }> = [
    { value: "narrow", label: "Narrow" },
    { value: "comfortable", label: "Comfortable" },
    { value: "full", label: "Full" },
  ];
  const SIDEBAR_MOTION_STEP_MS = 25;

  function commitSidebarMotionMs(value: number) {
    if (!Number.isFinite(value)) return;
    theme.setPersonal("sidebarMotionMs", value);
  }

  const isVisible = (id: string) => settingVisible(searchQuery, settingItems, id);

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

<SettingsSection {...settingsDefinitions["appearance.section-theme"]} visible={isVisible("theme")} plain>
  <ThemeModeTiles
    value={theme.themeMode}
    onSelect={(mode) => theme.setPersonal("themeMode", mode)}
  />
</SettingsSection>

<SettingsSection {...settingsDefinitions["appearance.section-custom-theme"]} visible={isVisible("custom-css")}>
  <SettingsRow {...settingsDefinitions["appearance.custom-css"]} visible={isVisible("custom-css")}>
    {#snippet body()}
      <ThemeCssField />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection {...settingsDefinitions["appearance.section-layout"]} visible={["conversation-width", "sidebar-view", "sidebar-places", "sidebar-motion", "project-panel-items"].some(isVisible)}>
  <SettingsRow
    {...settingsDefinitions["appearance.conversation-width"]}
    visible={isVisible("conversation-width")}
  >
    {#snippet control()}
      <SettingsSelect
        options={conversationWidths}
        value={theme.conversationWidth}
        onSelect={(value) => theme.setPersonal("conversationWidth", value)}
        ariaLabel="Conversation width"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["appearance.sidebar-view"]}
    visible={isVisible("sidebar-view")}
  >
    {#snippet control()}
      <SettingsSelect
        options={sidebarViews}
        value={theme.sidebarView}
        onSelect={(value) => theme.setPersonal("sidebarView", value)}
        ariaLabel="Sidebar view"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["appearance.sidebar-places"]}
    visible={isVisible("sidebar-places")}
  >
    {#snippet control()}
      {#if isPlacesLayoutChanged(theme.sidebarPlaces)}
        <Button variant="ghost" size="sm" onclick={() => theme.setPersonal("sidebarPlaces", { order: [], hidden: [] })}>
          Reset
        </Button>
      {/if}
      <Button
        bind:ref={placesTrigger}
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={placesMenuOpen}
        onclick={() => (placesMenuOpen = !placesMenuOpen)}
      >
        Choose…
      </Button>
      <SidebarPlacesMenu
        bind:open={placesMenuOpen}
        anchor={placesTrigger}
        side="bottom"
        align="end"
        focusOnClose="anchor"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["appearance.sidebar-motion"]}
    visible={isVisible("sidebar-motion")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-input bg-white shadow-xs/5 dark:bg-input/30"
      >
        <button
          type="button"
          onclick={() =>
            commitSidebarMotionMs(theme.sidebarMotionMs - SIDEBAR_MOTION_STEP_MS)}
          aria-label="Shorten sidebar animation"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >&minus;</button
        >
        <Input
          type="number"
          min={0}
          max={MAX_SIDEBAR_MOTION_MS}
          step={SIDEBAR_MOTION_STEP_MS}
          value={String(theme.sidebarMotionMs)}
          aria-label="Sidebar animation in milliseconds"
          onchange={(event) => {
            commitSidebarMotionMs(
              Number((event.target as HTMLInputElement).value),
            );
            (event.target as HTMLInputElement).value = String(
              theme.sidebarMotionMs,
            );
          }}
          class="h-auto w-10 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="mr-1 text-xs text-(--solus-text-tertiary)">ms</span>
        <button
          type="button"
          onclick={() =>
            commitSidebarMotionMs(theme.sidebarMotionMs + SIDEBAR_MOTION_STEP_MS)}
          aria-label="Lengthen sidebar animation"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >+</button
        >
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["appearance.project-panel-items"]}
    visible={isVisible("project-panel-items")}
  >
    {#snippet control()}
      {#if theme.projectPanelHiddenItems.length > 0}
        <Button variant="ghost" size="sm" onclick={() => theme.setPersonal("projectPanelHiddenItems", [])}>
          Reset
        </Button>
      {/if}
      <Button
        bind:ref={panelItemsTrigger}
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={panelItemsMenuOpen}
        onclick={() => (panelItemsMenuOpen = !panelItemsMenuOpen)}
      >
        Choose…
      </Button>
      <ProjectPanelItemsMenu
        bind:open={panelItemsMenuOpen}
        anchor={panelItemsTrigger}
        side="bottom"
        align="end"
        focusOnClose="anchor"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<!-- Decoration on this device: layout keys, not synced (docs/plans/sidebar-places-and-sky.md). -->
<SettingsSection {...settingsDefinitions["appearance.section-sky"]} visible={["sky-scene", "sidebar-sky", "draft-mark"].some(isVisible)}>
  <SettingsRow
    {...settingsDefinitions["appearance.sky-scene"]}
    visible={isVisible("sky-scene")}
  >
    {#snippet control()}
      <SettingsSelect
        options={skySceneChoices}
        value={theme.skySceneChoice}
        onSelect={(value) => theme.setLayout("skySceneChoice", value)}
        ariaLabel="Sky scene"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["appearance.sidebar-sky"]}
    visible={isVisible("sidebar-sky")}
  >
    {#snippet control()}
      <Switch
        checked={theme.showsSidebarSky}
        onCheckedChange={(next) => theme.setLayout("showsSidebarSky", next)}
        size="default"
        aria-label="Show the sky in the sidebar"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["appearance.draft-mark"]}
    visible={isVisible("draft-mark")}
  >
    {#snippet control()}
      <Switch
        checked={theme.showsDraftMark}
        onCheckedChange={(next) => theme.setLayout("showsDraftMark", next)}
        size="default"
        aria-label="Show the mark on the new-tab home"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  {...settingsDefinitions["appearance.section-typography"]}
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
    {...settingsDefinitions["appearance.font-family"]}
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
    {...settingsDefinitions["appearance.prompt-font-family"]}
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
    {...settingsDefinitions["appearance.document-font-family"]}
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
    {...settingsDefinitions["appearance.code-font-family"]}
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
    {...settingsDefinitions["appearance.reply-opacity"]}
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
    {...settingsDefinitions["appearance.font-smoothing"]}
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
  {...settingsDefinitions["appearance.section-installed-fonts"]}
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
