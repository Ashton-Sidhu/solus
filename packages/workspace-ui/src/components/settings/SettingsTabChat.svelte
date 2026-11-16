<script lang="ts">
  import { settingVisible } from "@solus/client-core/settings-search";
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { chatSettings as settingItems } from "./lib/settings-search-data";
  import type { ArtifactChipSize, ResponseStreamingMode } from "@solus/contracts/settings";
  import { getSettingsContext } from "../../contexts";
  import { Switch } from "../ui/switch";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  let { searchQuery = "" }: { searchQuery?: string } = $props();
  const theme = getSettingsContext();
  const responseStreamingModes = [
    { value: "buffered", label: "Buffered" },
    { value: "paragraph", label: "Streaming" },
  ] satisfies Array<{ value: ResponseStreamingMode; label: string }>;
  const artifactChipSizes = [
    { value: "small", label: "Small" },
    { value: "medium", label: "Medium" },
    { value: "large", label: "Large" },
  ] satisfies Array<{ value: ArtifactChipSize; label: string }>;
  const isVisible = (id: string) => settingVisible(searchQuery, settingItems, id);
</script>

<SettingsSection {...settingsDefinitions["chat.section-conversation"]} visible={settingItems.some((item) => isVisible(item.id))}>
  <SettingsRow
    {...settingsDefinitions["chat.response-streaming"]}
    visible={isVisible("response-streaming")}
  >
    {#snippet control()}
      <SettingsSelect
        options={responseStreamingModes}
        value={theme.responseStreamingMode}
        onSelect={(value) => theme.setPersonal("responseStreamingMode", value)}
        ariaLabel="Response streaming"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["chat.turn-diff-summary"]}
    visible={isVisible("turn-diff-summary")}
  >
    {#snippet control()}
      <Switch
        checked={theme.showDiffSummaryAfterTurn}
        onCheckedChange={(next) =>
          theme.setPersonal("showDiffSummaryAfterTurn", next)}
        size="default"
        aria-label="Toggle changed files summaries after turns"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["chat.keep-turn-diff-summary"]}
    visible={isVisible("keep-turn-diff-summary")}
  >
    {#snippet control()}
      <Switch
        checked={theme.keepDiffSummaryOnEarlierTurns}
        disabled={!theme.showDiffSummaryAfterTurn}
        onCheckedChange={(next) =>
          theme.setPersonal("keepDiffSummaryOnEarlierTurns", next)}
        size="default"
        aria-label="Toggle changed files summaries on earlier turns"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["chat.auto-open-artifacts"]}
    visible={isVisible("auto-open-artifacts")}
  >
    {#snippet control()}
      <Switch
        checked={theme.autoOpenArtifacts}
        onCheckedChange={(next) => theme.setPersonal("autoOpenArtifacts", next)}
        size="default"
        aria-label="Open artifacts automatically"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["chat.artifact-chip-size"]}
    visible={isVisible("artifact-chip-size")}
  >
    {#snippet control()}
      <SettingsSelect
        options={artifactChipSizes}
        value={theme.artifactChipSize}
        onSelect={(value) => theme.setPersonal("artifactChipSize", value)}
        ariaLabel="Artifact chip size"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["chat.show-tool-calls"]}
    visible={isVisible("show-tool-calls")}
  >
    {#snippet control()}
      <Switch
        checked={theme.showToolCalls}
        onCheckedChange={(next) => theme.setPersonal("showToolCalls", next)}
        size="default"
        aria-label="Toggle tool calls in the transcript"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["chat.collapse-composer"]}
    visible={isVisible("collapse-composer")}
  >
    {#snippet control()}
      <Switch
        checked={theme.collapseComposerWhenIdle}
        onCheckedChange={(next) =>
          theme.setPersonal("collapseComposerWhenIdle", next)}
        size="default"
        aria-label="Toggle collapsing the input bar when idle"
      />
    {/snippet}
  </SettingsRow>

</SettingsSection>
