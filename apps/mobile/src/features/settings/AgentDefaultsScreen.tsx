// Adapted from T3 Code apps/mobile/src/features/settings/SettingsThreadsRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import type { PersonalSettingsDocument } from "@solus/contracts/settings";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import {
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
import { RATE_LIMIT_CHOICES } from "./lib/settings-labels";
import { PolicyLockNote } from "../policy/PolicyLockNote";
import { useManagedSettingLines, usePermissionCeilingLines } from "../policy/use-host-policy";

/**
 * What a new session starts with and how its runs behave. These are the
 * person's own settings (plans/018): they follow them to every host, and to
 * every device when sync is on.
 */
export function AgentDefaultsScreen(_props: ScreenProps<"AgentDefaults">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  // Each value is read alone, so a change to another setting (a sync from
  // another device) does not re-render the page.
  const { changes, current } = app.personal;
  const agent = useListened(changes, () => current().activeAgent);
  const defaultPermissionMode = useListened(changes, () => current().defaultPermissionMode);
  const rateLimitBehavior = useListened(changes, () => current().rateLimitBehavior);
  const autoRenameSessions = useListened(changes, () => current().autoRenameSessions);
  // A policy locks these on its hosts; new sessions there start at the ceiling (plans/030 §7).
  const defaultModeLines = useManagedSettingLines("defaultPermissionMode");
  const ceilingLines = usePermissionCeilingLines();
  const rateLimitLines = useManagedSettingLines("rateLimitBehavior");
  const update = (patch: PersonalSettingsDocument) => {
    app.personal.set(patch);
  };

  return (
    <SettingsScreen title="Sessions">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Default provider">
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
          <SettingsSection title="Permissions">
            {PERMISSION_MODES.map((mode, index) => (
              <SettingsChoiceRow
                key={mode}
                separated={index > 0}
                label={PERMISSION_MODE_TEXT[mode].label}
                description={PERMISSION_MODE_TEXT[mode].description}
                icon={PERMISSION_MODE_ICON[mode]}
                selected={defaultPermissionMode === mode}
                onPress={() => update({ defaultPermissionMode: mode })}
              />
            ))}
          </SettingsSection>
          <PolicyLockNote lines={[...defaultModeLines, ...ceilingLines]} />
          <SettingsNote>How much a new session may do without asking you.</SettingsNote>
        </View>

        <View className="gap-3">
          <SettingsSection title="Rate limits">
            {RATE_LIMIT_CHOICES.map((choice, index) => (
              <SettingsChoiceRow
                key={choice.mode}
                separated={index > 0}
                label={choice.label}
                selected={rateLimitBehavior === choice.mode}
                onPress={() => update({ rateLimitBehavior: choice.mode })}
              />
            ))}
          </SettingsSection>
          <PolicyLockNote lines={rateLimitLines} />
          <SettingsNote>What your runs do when they hit a provider rate limit.</SettingsNote>
        </View>

        <SettingsSection title="Sessions">
          <SettingsSwitchRow
            icon="pencil"
            label="Name sessions automatically"
            subtitle="Summarize the first prompt into a short session name."
            value={autoRenameSessions}
            onValueChange={(next) => update({ autoRenameSessions: next })}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
