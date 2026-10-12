import { useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { AgentProfileEnableOffer, AgentProfileEnableOutcome } from "@solus/client-core/agent-profile-sync";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { formatTime, HostsSection, InstructionsSection, ServersSection, SkillsSection } from "./AgentProfileSections";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { entryKeyLabel, entryValueText } from "./lib/agent-profile-entries";
import { SYNC_STATE_LABELS } from "./lib/settings-labels";
import { AGENT_PROFILE_SUBJECT, syncStatusDetail } from "./lib/sync-text";
import { enableChoicesFor, type EnableChoiceKind } from "./personal-sync";
import { useAgentProfile } from "./use-agent-profile";

const ENABLE_CHOICE_TEXT = {
  "use-synced": {
    label: "Use synced profile",
    description: "This device takes the profile your account already has.",
  },
  replace: {
    label: "Replace with this device",
    description: "Your account and every host take this device’s copy.",
  },
  seed: {
    label: "Start with this device",
    description: "Your account has no synced profile yet. This device’s copy becomes it.",
  },
} as const satisfies Record<EnableChoiceKind, { label: string; description: string }>;

/**
 * The person's agent profile on this device (plans/020-agent-profile.md §3):
 * instructions, skills, and MCP servers, their sync with the account, and
 * their copy on each host. The same capability as Settings → Agent profile on
 * desktop and web, without "Import from this computer": a phone has none.
 */
export function AgentProfileScreen({ navigation }: ScreenProps<"AgentProfile">) {
  const insets = useSafeAreaInsets();
  const profile = useAgentProfile();
  const { sync, status } = profile;
  const [offer, setOffer] = useState<AgentProfileEnableOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const isOn = !["signed-out", "off", "loading"].includes(status.state);
  const isSignedIn = status.state !== "signed-out";

  const startEnable = async () => {
    setMessage("");
    setBusy(true);
    const outcome = await sync.prepareEnable();
    setBusy(false);
    if (outcome.kind === "offer") setOffer(outcome.offer);
    else if (outcome.kind !== "cancelled") setMessage(unavailableText(outcome));
  };

  const choose = async (kind: EnableChoiceKind) => {
    setBusy(true);
    const outcome = await sync.enable(kind);
    setBusy(false);
    handleEnable(outcome);
  };

  const handleEnable = (outcome: AgentProfileEnableOutcome) => {
    if (outcome.kind === "enabled" || outcome.kind === "cancelled") {
      setOffer(null);
      setMessage("");
    } else if (outcome.kind === "changed") {
      setOffer(outcome.offer);
      setMessage("Your synced profile changed a moment ago. Nothing was overwritten. Choose again.");
    } else if (outcome.kind === "invalid") {
      setOffer(null);
      setMessage("This profile could not be sent. Nothing was changed.");
    } else {
      setMessage(unavailableText(outcome));
    }
  };

  const confirmChoice = (kind: EnableChoiceKind) => {
    if (kind !== "replace") return void choose(kind);
    Alert.alert("Replace synced profile?", "Your account and every host take this device’s copy.", [
      { text: "Cancel", style: "cancel" },
      { text: "Replace", style: "destructive", onPress: () => void choose(kind) },
    ]);
  };

  const toggle = (next: boolean) => {
    if (next) return void startEnable();
    Alert.alert(
      "Turn off sync on this device?",
      "Your profile stays on this device. Your account and your hosts keep theirs.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Turn off", style: "destructive", onPress: () => sync.turnOff() },
      ],
    );
  };

  const clear = async (discardUnsent: boolean) => {
    setBusy(true);
    const outcome = await sync.engine.clearCloud({ discardUnsent });
    setBusy(false);
    if (outcome.kind === "has-unsent") {
      Alert.alert(
        "Discard unsent changes?",
        `${outcome.keys.length === 1 ? "1 change has" : `${outcome.keys.length} changes have`} not synced yet. Clearing discards them from your account; they stay on this device.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Clear", style: "destructive", onPress: () => void clear(true) },
        ],
      );
    } else if (outcome.kind === "cleared") {
      setOffer(null);
      setMessage("The synced profile was cleared. Your other devices stop syncing when they next connect.");
    } else if (outcome.kind !== "cancelled") {
      setMessage(unavailableText(outcome));
    }
  };

  const confirmClear = () =>
    Alert.alert(
      "Clear synced profile?",
      "Your account’s copy is deleted and sync turns off on every device. Each device keeps its own copy.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: () => void clear(false) },
      ],
    );

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
        <View className="gap-3">
          <SettingsSection title="Sync">
            {isSignedIn ? (
              <SettingsSwitchRow
                icon="arrow.clockwise"
                label="Sync profile on this device"
                subtitle={SYNC_STATE_LABELS[status.state]}
                value={isOn || offer !== null}
                disabled={busy || status.state === "loading"}
                onValueChange={toggle}
              />
            ) : (
              <SettingsRow
                icon="person.crop.circle"
                label="Sign in to Solus Cloud"
                accessibilityHint="Sync needs your account"
                onPress={() => navigation.navigate("CloudSignIn")}
              />
            )}
          </SettingsSection>
          <SettingsNote>{syncStatusDetail(status, formatTime, AGENT_PROFILE_SUBJECT)}</SettingsNote>
          {message ? <SettingsNote tone="danger">{message}</SettingsNote> : null}
        </View>

        {offer && !isOn ? (
          <View className="gap-3">
            <SettingsSection title="Turn on sync">
              {enableChoicesFor(offer).map((kind, index) => (
                <SettingsChoiceRow
                  key={kind}
                  separated={index > 0}
                  label={ENABLE_CHOICE_TEXT[kind].label}
                  description={ENABLE_CHOICE_TEXT[kind].description}
                  selected={false}
                  disabled={busy}
                  onPress={() => confirmChoice(kind)}
                />
              ))}
              <SettingsActionRow icon="xmark" label="Cancel" disabled={busy} onPress={() => setOffer(null)} />
            </SettingsSection>
            {offer.kind === "present" && offer.updatedAt ? (
              <SettingsNote>{`Your account’s profile was last changed ${formatTime(offer.updatedAt)}.`}</SettingsNote>
            ) : null}
          </View>
        ) : null}

        {isOn ? (
          <SettingsSection title="Status">
            <SettingsValueRow icon="info.circle" label="Status" value={SYNC_STATE_LABELS[status.state]} />
            <SettingsValueRow icon="clock" label="Last synced" value={status.lastSyncedAt === null ? "Never" : formatTime(status.lastSyncedAt)} />
            <SettingsValueRow icon="tray.and.arrow.up" label="Waiting to send" value={String(status.pendingKeys.length)} />
            <SettingsActionRow icon="arrow.clockwise" label="Sync now" disabled={busy} onPress={() => void sync.engine.refresh()} />
          </SettingsSection>
        ) : null}

        {status.conflicts.map((conflict) => (
          <View key={conflict.key} className="gap-3">
            <SettingsSection title={entryKeyLabel(conflict.key)}>
              <SettingsActionRow
                icon={{ ios: "iphone", android: "smartphone" }}
                label="Keep mine"
                onPress={() => sync.engine.resolveConflict(conflict.key, "keep-mine")}
              />
              <SettingsActionRow icon="cloud" label="Take theirs" onPress={() => sync.engine.resolveConflict(conflict.key, "take-theirs")} />
            </SettingsSection>
            <SettingsNote>{`On this device: ${entryValueText(conflict.mine, conflict.key)}. Synced: ${entryValueText(conflict.theirs, conflict.key)}.`}</SettingsNote>
          </View>
        ))}

        <InstructionsSection profile={profile} />
        <SkillsSection profile={profile} />
        <ServersSection profile={profile} />
        <HostsSection profile={profile} />

        {isSignedIn ? (
          <View className="gap-3">
            <SettingsSection>
              <SettingsActionRow icon="trash" label="Clear synced profile" tone="danger" loading={busy} disabled={busy} onPress={confirmClear} />
            </SettingsSection>
            <SettingsNote>Deletes your account’s copy. Every device keeps its own copy and stops syncing.</SettingsNote>
          </View>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}

function unavailableText(outcome: { kind: "signed-out" } | { kind: "offline" } | { kind: "error"; code: string; message: string | null }): string {
  if (outcome.kind === "signed-out") return "Sign in to Solus Cloud again to sync.";
  if (outcome.kind === "offline") return "Solus Cloud did not answer. Check your connection and try again.";
  return `Solus Cloud refused: ${outcome.message ?? outcome.code}.`;
}
