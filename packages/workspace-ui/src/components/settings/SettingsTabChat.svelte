<script lang="ts">
  import { chatSettings as settingItems } from "./lib/settings-search-data";
  import type { ResponseStreamingMode } from "@solus/contracts/settings";
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
  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    return settingItems.find((item) => item.id === id)?.keywords.some((word) => word.includes(searchQuery.toLowerCase())) ?? false;
  }
</script>

<SettingsSection label="Conversation" visible={settingItems.some((item) => isVisible(item.id))}>
  <SettingsRow
    label="Response streaming"
    description="Show paragraphs and code blocks as they finish, or wait for each segment."
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
    label="Show changed files after turns"
    description="Show a diff summary after each turn."
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
    label="Keep changed files on earlier turns"
    description="Off shows the summary for the latest turn only."
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
    label="Show tool calls"
    description="Off shows only the agent's messages, questions, and cards."
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
    label="Collapse the input bar when idle"
    description="Hide the toolbar until the input bar has focus."
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
