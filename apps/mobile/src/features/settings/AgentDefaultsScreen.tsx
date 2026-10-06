// Adapted from T3 Code apps/mobile/src/features/settings/SettingsThreadsRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import type { PersonalSettings, PersonalSettingsDocument } from "@solus/contracts/settings";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import {
  modelChoices,
  PERMISSION_MODE_ICON,
  PERMISSION_MODE_TEXT,
  PERMISSION_MODES,
  PROVIDERS,
} from "../conversation/lib/run-settings";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { RATE_LIMIT_CHOICES, STREAMING_CHOICES } from "./lib/settings-labels";

/**
 * What a new session starts with and how its runs behave. These are the
 * person's own settings (plans/018): they follow them to every host, and to
 * every device when sync is on.
 */
export function AgentDefaultsScreen(_props: ScreenProps<"AgentDefaults">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const settings = useListened(app.personal.changes, app.personal.current);
  const update = (patch: PersonalSettingsDocument) => {
    app.personal.set(patch);
  };

  const agent = settings.activeAgent;
  const agentLabel = PROVIDERS.find((provider) => provider.id === agent)?.label ?? agent;
  const defaultModel = settings.defaultModels[agent] ?? null;
  // `defaultModels` is replaced as a whole, so the other agents' choices ride along.
  const setDefaultModel = (modelId: string | null) => {
    const next: PersonalSettings["defaultModels"] = { ...settings.defaultModels };
    if (modelId) next[agent] = modelId;
    else delete next[agent];
    update({ defaultModels: next });
  };

  return (
    <SettingsScreen title="Agent defaults">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Default agent">
          {PROVIDERS.map((provider, index) => (
            <SettingsChoiceRow
              key={provider.id}
              separated={index > 0}
              label={provider.label}
              selected={agent === provider.id}
              onPress={() => update({ activeAgent: provider.id })}
            />
          ))}
        </SettingsSection>

        <View className="gap-3">
          <SettingsSection title={`Default model for ${agentLabel}`}>
            <SettingsChoiceRow
              separated={false}
              label="Built-in default"
              description={`The model ${agentLabel} uses when none is chosen.`}
              selected={defaultModel === null}
              onPress={() => setDefaultModel(null)}
            />
            {modelChoices(agent, defaultModel).map((model) => (
              <SettingsChoiceRow
                key={model.id}
                separated
                label={model.label}
                selected={defaultModel === model.id}
                onPress={() => setDefaultModel(model.id)}
              />
            ))}
          </SettingsSection>
          <SettingsNote>
            A session can still pick another model before its first prompt.
          </SettingsNote>
        </View>

        <View className="gap-3">
          <SettingsSection title="Permissions">
            {PERMISSION_MODES.map((mode, index) => (
              <SettingsChoiceRow
                key={mode}
                separated={index > 0}
                label={PERMISSION_MODE_TEXT[mode].label}
                description={PERMISSION_MODE_TEXT[mode].description}
                icon={PERMISSION_MODE_ICON[mode]}
                selected={settings.defaultPermissionMode === mode}
                onPress={() => update({ defaultPermissionMode: mode })}
              />
            ))}
          </SettingsSection>
          <SettingsNote>How much a new session may do without asking you.</SettingsNote>
        </View>

        <SettingsSection title="Responses">
          {STREAMING_CHOICES.map((choice, index) => (
            <SettingsChoiceRow
              key={choice.mode}
              separated={index > 0}
              label={choice.label}
              description={choice.description}
              selected={settings.responseStreamingMode === choice.mode}
              onPress={() => update({ responseStreamingMode: choice.mode })}
            />
          ))}
        </SettingsSection>

        <View className="gap-3">
          <SettingsSection title="Rate limits">
            {RATE_LIMIT_CHOICES.map((choice, index) => (
              <SettingsChoiceRow
                key={choice.mode}
                separated={index > 0}
                label={choice.label}
                selected={settings.rateLimitBehavior === choice.mode}
                onPress={() => update({ rateLimitBehavior: choice.mode })}
              />
            ))}
          </SettingsSection>
          <SettingsNote>What your runs do when they hit a provider rate limit.</SettingsNote>
        </View>

        <SettingsSection title="Sessions">
          <SettingsSwitchRow
            icon="pencil"
            label="Name sessions automatically"
            subtitle="Summarize the first prompt into a short session name."
            value={settings.autoRenameSessions}
            onValueChange={(next) => update({ autoRenameSessions: next })}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
