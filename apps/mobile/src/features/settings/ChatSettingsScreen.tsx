import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, useListened } from "../../app/app-context";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { STREAMING_CHOICES } from "./lib/settings-labels";

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
      <SettingsSection title="Conversation">
        <SettingsSwitchRow label="Show changed files after turns" value={settings.showDiffSummaryAfterTurn} onValueChange={(value) => app.personal.set({ showDiffSummaryAfterTurn: value })} />
        <SettingsSwitchRow label="Keep changed files on earlier turns" subtitle="Off shows the summary for the latest turn only." disabled={!settings.showDiffSummaryAfterTurn} value={settings.keepDiffSummaryOnEarlierTurns} onValueChange={(value) => app.personal.set({ keepDiffSummaryOnEarlierTurns: value })} />
        <SettingsSwitchRow label="Show tool calls" value={settings.showToolCalls} onValueChange={(value) => app.personal.set({ showToolCalls: value })} />
        <SettingsSwitchRow label="Collapse the input bar when idle" value={settings.collapseComposerWhenIdle} onValueChange={(value) => app.personal.set({ collapseComposerWhenIdle: value })} />
      </SettingsSection>
    </ScreenScrollView>
  </SettingsScreen>;
}
