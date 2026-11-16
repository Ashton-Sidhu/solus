import { settingsDefinitions } from "@solus/client-core/settings-definitions";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, useListened } from "../../app/app-context";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { ARTIFACT_CHIP_SIZE_CHOICES, STREAMING_CHOICES } from "./lib/settings-labels";

export function ChatSettingsScreen(_props: ScreenProps<"ChatSettings">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const settings = useListened(app.personal.changes, app.personal.current);
  return <SettingsScreen title="Chat">
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}>
      <SettingsSection title="Responses">
        {STREAMING_CHOICES.map((choice, index) => <SettingsChoiceRow key={choice.mode} separated={index > 0}
          label={choice.label} description={choice.description} selected={settings.responseStreamingMode === choice.mode}
          onPress={() => app.personal.set({ responseStreamingMode: choice.mode })} />)}
      </SettingsSection>
      <SettingsSection title={settingsDefinitions["chat.artifact-chip-size"].label}>
        {ARTIFACT_CHIP_SIZE_CHOICES.map((choice, index) => <SettingsChoiceRow key={choice.size} separated={index > 0}
          label={choice.label} selected={settings.artifactChipSize === choice.size}
          onPress={() => app.personal.set({ artifactChipSize: choice.size })} />)}
      </SettingsSection>
      <SettingsSection title={settingsDefinitions["chat.section-conversation"].label}>
        <SettingsSwitchRow label={settingsDefinitions["chat.turn-diff-summary"].label} value={settings.showDiffSummaryAfterTurn} onValueChange={(value) => app.personal.set({ showDiffSummaryAfterTurn: value })} />
        <SettingsSwitchRow label={settingsDefinitions["chat.keep-turn-diff-summary"].label} subtitle={settingsDefinitions["chat.keep-turn-diff-summary"].description} disabled={!settings.showDiffSummaryAfterTurn} value={settings.keepDiffSummaryOnEarlierTurns} onValueChange={(value) => app.personal.set({ keepDiffSummaryOnEarlierTurns: value })} />
        <SettingsSwitchRow label={settingsDefinitions["chat.auto-open-artifacts"].label} subtitle="Open new artifacts on desktop and web. Mobile keeps new items in the thread menu." value={settings.autoOpenArtifacts} onValueChange={(value) => app.personal.set({ autoOpenArtifacts: value })} />
        <SettingsSwitchRow label={settingsDefinitions["chat.show-tool-calls"].label} value={settings.showToolCalls} onValueChange={(value) => app.personal.set({ showToolCalls: value })} />
        <SettingsSwitchRow label={settingsDefinitions["chat.collapse-composer"].label} value={settings.collapseComposerWhenIdle} onValueChange={(value) => app.personal.set({ collapseComposerWhenIdle: value })} />
      </SettingsSection>
    </ScreenScrollView>
  </SettingsScreen>;
}
