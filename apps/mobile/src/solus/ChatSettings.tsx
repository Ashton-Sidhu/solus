import { settingsDefinitions } from "@solus/client-core/settings-definitions";
import { useListened } from "@solus-mobile/app/app-context";
import { solus as app } from "./runtime";

import { SettingsSection } from "../features/settings/components/SettingsSection";
import { ListChoiceRow as SettingsChoiceRow } from "../components/ui/ListChoiceRow";
import { SettingsSwitchRow } from "../features/settings/components/SettingsSwitchRow";
import {
  ARTIFACT_CHIP_SIZE_CHOICES,
  STREAMING_CHOICES,
} from "./settings-labels";

export function SolusChatSections() {
  const settings = useListened(app.personal.changes, app.personal.current);
  return (
    <>
      <SettingsSection title="Responses">
        {STREAMING_CHOICES.map((choice, index) => (
          <SettingsChoiceRow
            key={choice.mode}
            separated={index > 0}
            label={choice.label}
            description={choice.description}
            selected={settings.responseStreamingMode === choice.mode}
            onPress={() =>
              app.personal.set({ responseStreamingMode: choice.mode })
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection
        title={
          settingsDefinitions["chat.artifact-chip-size"].label +
          " (desktop and web)"
        }
      >
        {ARTIFACT_CHIP_SIZE_CHOICES.map((choice, index) => (
          <SettingsChoiceRow
            key={choice.size}
            separated={index > 0}
            label={choice.label}
            selected={settings.artifactChipSize === choice.size}
            onPress={() => app.personal.set({ artifactChipSize: choice.size })}
          />
        ))}
      </SettingsSection>
      <SettingsSection
        title={settingsDefinitions["chat.section-conversation"].label}
      >
        <SettingsSwitchRow
          label={settingsDefinitions["chat.turn-diff-summary"].label}
          subtitle="Show the change summary on desktop and web."
          value={settings.showDiffSummaryAfterTurn}
          onValueChange={(value) =>
            app.personal.set({ showDiffSummaryAfterTurn: value })
          }
        />
        <SettingsSwitchRow
          label={settingsDefinitions["chat.keep-turn-diff-summary"].label}
          subtitle={
            settingsDefinitions["chat.keep-turn-diff-summary"].description
          }
          disabled={!settings.showDiffSummaryAfterTurn}
          value={settings.keepDiffSummaryOnEarlierTurns}
          onValueChange={(value) =>
            app.personal.set({ keepDiffSummaryOnEarlierTurns: value })
          }
        />
        <SettingsSwitchRow
          label={settingsDefinitions["chat.hide-server-background-work"].label}
          subtitle={
            settingsDefinitions["chat.hide-server-background-work"].description
          }
          value={settings.hideServerBackgroundWork}
          onValueChange={(value) =>
            app.personal.set({ hideServerBackgroundWork: value })
          }
        />
        <SettingsSwitchRow
          label={settingsDefinitions["chat.auto-open-artifacts"].label}
          subtitle="Open new artifacts on desktop and web. Mobile keeps new items in the thread menu."
          value={settings.autoOpenArtifacts}
          onValueChange={(value) =>
            app.personal.set({ autoOpenArtifacts: value })
          }
        />
        <SettingsSwitchRow
          label={settingsDefinitions["chat.show-tool-calls"].label}
          value={settings.showToolCalls}
          onValueChange={(value) => app.personal.set({ showToolCalls: value })}
        />
        <SettingsSwitchRow
          label={settingsDefinitions["chat.collapse-composer"].label}
          subtitle="Collapse the composer on desktop and web."
          value={settings.collapseComposerWhenIdle}
          onValueChange={(value) =>
            app.personal.set({ collapseComposerWhenIdle: value })
          }
        />
      </SettingsSection>
    </>
  );
}
