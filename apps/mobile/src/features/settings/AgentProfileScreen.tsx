import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { FilesSection, InstructionsSection, ServersSection, SkillsSection } from "./AgentProfileSections";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { entryKeyLabel, entryValueText } from "./lib/agent-profile-entries";
import { useAgentProfile } from "./use-agent-profile";

/**
 * The person's agent profile on this device (plans/020-agent-profile.md §3):
 * the person's instructions (a personal setting every prompt carries), their
 * skills, MCP servers, and copied files. The same capability as Settings →
 * Agent profile on desktop and web, without "Import from this computer": a
 * phone has none. The account's sync, the hosts, and the clear are on
 * Account & sync; an entry two devices changed is resolved here, beside the
 * content.
 */
export function AgentProfileScreen({ navigation }: ScreenProps<"AgentProfile">) {
  const insets = useSafeAreaInsets();
  const profile = useAgentProfile();
  const { sync, status } = profile;

  return (
    <SettingsScreen title="Agent profile">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        keyboardShouldPersistTaps="handled"
      >
        {status.state === "signed-out" ? (
          <View className="gap-3">
            <SettingsSection>
              <SettingsRow
                icon="person.crop.circle"
                label="Sign in to Solus Cloud"
                accessibilityHint="Signing in syncs your agent profile to every host and device"
                onPress={() => navigation.navigate("CloudSignIn")}
              />
            </SettingsSection>
            <SettingsNote>Signed in, your agent profile syncs through your account to every host you work on. It works on this device without it.</SettingsNote>
          </View>
        ) : null}

        {status.conflicts.map((conflict) => (
          <View key={conflict.key} className="gap-3">
            <SettingsSection title={entryKeyLabel(conflict.key)}>
              <SettingsActionRow
                icon={{ ios: "iphone", android: "smartphone" }}
                label="Keep mine"
                onPress={() => sync.profileEngine.resolveConflict(conflict.key, "keep-mine")}
              />
              <SettingsActionRow icon="cloud" label="Take theirs" onPress={() => sync.profileEngine.resolveConflict(conflict.key, "take-theirs")} />
            </SettingsSection>
            <SettingsNote>{`On this device: ${entryValueText(conflict.mine, conflict.key)}. Synced: ${entryValueText(conflict.theirs, conflict.key)}.`}</SettingsNote>
          </View>
        ))}

        <InstructionsSection profile={profile} />
        <SkillsSection profile={profile} />
        <ServersSection profile={profile} />
        <FilesSection profile={profile} />
      </ScrollView>
    </SettingsScreen>
  );
}
