import { useCallback, useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useFocusEffect } from "@react-navigation/native";
import { useApp, useListened } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import { HostsSection } from "./AgentProfileSections";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { syncUnavailableText } from "./lib/agent-profile-entries";
import { SYNC_STATE_LABELS } from "./lib/settings-labels";
import { accountSyncDetail, settingKeyLabel, settingValueText } from "./lib/sync-text";
import { useAgentProfileHosts } from "./use-agent-profile";

const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString();

/**
 * Settings → Account & sync (plans/018 decision 9): the one place for the
 * account on the phone. Who is signed in; one status for the two synced
 * documents, the settings and the agent profile; the settings' conflicts,
 * resolved here, and the profile's, resolved on its screen; the two clear
 * actions; and each host with what it holds of the profile. Signed in is
 * synced: there is no switch. Works without any host.
 */
export function AccountSyncScreen({ navigation }: ScreenProps<"AccountSync">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const sync = app.accountSync;
  const status = useListened(sync.changes, sync.current);
  const settings = useListened(sync.changes, sync.currentSettings);
  const profile = useListened(sync.changes, sync.currentProfile);
  const account = useListened(app.account.changes, () => app.account.view);
  const { hosts } = useAgentProfileHosts();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // The screen opened: read the account now rather than at the next poll, and try a start that failed again.
  useFocusEffect(
    useCallback(() => {
      void sync.syncNow();
    }, [sync]),
  );

  const isSignedIn = status.state !== "signed-out";

  const clear = async (document: "settings" | "profile", discardUnsent: boolean) => {
    setBusy(true);
    const outcome = document === "settings" ? await sync.clearSettings({ discardUnsent }) : await sync.clearProfile({ discardUnsent });
    setBusy(false);
    if (outcome.kind === "has-unsent") {
      Alert.alert(
        "Discard unsent changes?",
        `${outcome.keys.length === 1 ? "1 change has" : `${outcome.keys.length} changes have`} not synced yet. Clearing discards them from your account; they stay on this device.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Clear", style: "destructive", onPress: () => void clear(document, true) },
        ],
      );
    } else if (outcome.kind === "cleared") {
      setMessage(
        document === "settings"
          ? "Synced settings were cleared and started again from this device. Your other devices take the new copy."
          : "The synced profile was cleared and started again from this device. Your other devices and every host take the new copy.",
      );
    } else if (outcome.kind !== "cancelled") {
      setMessage(syncUnavailableText(outcome));
    }
  };

  const confirmClear = (document: "settings" | "profile") =>
    Alert.alert(
      document === "settings" ? "Clear synced settings?" : "Clear synced profile?",
      document === "settings"
        ? "Your account’s copy is deleted, and your synced settings start again from this device’s. Your other devices take them when they next sync."
        : "Your account’s copy is deleted, and your synced profile starts again from this device’s copy. Your other devices and every host take it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: () => void clear(document, false) },
      ],
    );

  return (
    <SettingsScreen title="Account & sync">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3">
          <SettingsSection title="Account">
            {account.kind === "signed-in" ? (
              <SettingsValueRow
                icon="person.crop.circle"
                label="Signed in"
                value={account.identity.name ?? account.identity.email}
                detail={account.identity.name ? account.identity.email : undefined}
                imageUri={account.identity.picture}
              />
            ) : (
              <SettingsRow
                icon="person.crop.circle"
                label="Sign in to Solus Cloud"
                accessibilityHint="Signing in syncs your settings and agent profile"
                onPress={() => navigation.navigate("CloudSignIn")}
              />
            )}
          </SettingsSection>
          <SettingsNote>{accountSyncDetail(status, formatTime)}</SettingsNote>
          {message ? <SettingsNote tone={status.state === "error" ? "danger" : undefined}>{message}</SettingsNote> : null}
        </View>

        {isSignedIn ? (
          <SettingsSection title="Sync">
            <SettingsValueRow icon="info.circle" label="Status" value={SYNC_STATE_LABELS[status.state]} />
            <SettingsValueRow icon="clock" label="Last synced" value={status.lastSyncedAt === null ? "Never" : formatTime(status.lastSyncedAt)} />
            <SettingsValueRow icon="tray.and.arrow.up" label="Waiting to send" value={String(status.pendingCount)} />
            <SettingsActionRow icon="arrow.clockwise" label="Sync now" disabled={busy || status.state === "loading"} onPress={() => void sync.syncNow()} />
          </SettingsSection>
        ) : null}

        {settings.conflicts.map((conflict) => (
          <View key={conflict.key} className="gap-3">
            <SettingsSection title={settingKeyLabel(conflict.key)}>
              <SettingsActionRow
                icon={{ ios: "iphone", android: "smartphone" }}
                label="Keep this device’s"
                onPress={() => sync.settingsEngine.resolveConflict(conflict.key, "keep-mine")}
              />
              <SettingsActionRow icon="cloud" label="Use synced" onPress={() => sync.settingsEngine.resolveConflict(conflict.key, "take-theirs")} />
            </SettingsSection>
            <SettingsNote>{`On this device: ${settingValueText(conflict.mine, conflict.key)}. Synced: ${settingValueText(conflict.theirs, conflict.key)}.`}</SettingsNote>
          </View>
        ))}

        {profile.conflicts.length > 0 ? (
          <View className="gap-3">
            <SettingsSection>
              <SettingsRow
                icon="doc.text"
                label={profile.conflicts.length === 1 ? "1 entry of your agent profile changed on two devices" : `${profile.conflicts.length} entries of your agent profile changed on two devices`}
                accessibilityHint="Resolve them on the agent profile screen"
                onPress={() => navigation.navigate("AgentProfile")}
              />
            </SettingsSection>
          </View>
        ) : null}

        <HostsSection hosts={hosts} sync={sync} />

        {isSignedIn ? (
          <View className="gap-3">
            <SettingsSection>
              <SettingsActionRow icon="trash" label="Clear synced settings" tone="danger" loading={busy} disabled={busy} onPress={() => confirmClear("settings")} />
              <SettingsActionRow icon="trash" label="Clear synced profile" tone="danger" loading={busy} disabled={busy} onPress={() => confirmClear("profile")} />
            </SettingsSection>
            <SettingsNote>Each deletes your account’s copy and starts it again from this device. Your other devices take the new copy; for the profile, every host does too.</SettingsNote>
          </View>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
