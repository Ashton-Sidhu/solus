import { useEffect, useState, type ReactNode } from "react";
import { Alert } from "react-native";
import {
  type StaticScreenProps,
  useNavigation,
} from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { parseVoiceDictionary } from "@solus/contracts/voice-dictionary";
import {
  PROVIDERS,
  modelChoices,
} from "@solus-mobile/features/conversation/lib/run-settings";
import { useListened } from "@solus-mobile/app/app-context";
import { AppText, AppTextInput } from "../components/ui/AppText";
import { ScreenScrollView } from "../components/ui/ScreenScrollView";
import { ListChoiceRow } from "../components/ui/ListChoiceRow";
import { SettingsScreen } from "../features/settings/components/SettingsScreen";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../features/settings/components/SettingsSwitchRow";
import { nearby, solus, useSolusDirectory } from "./runtime";
import { SYNC_STATE_LABELS } from "./settings-labels";

export function SettingsPage({
  title,
  children,
  ...bar
}: Pick<React.ComponentProps<typeof SettingsScreen>, "menus" | "actions" | "guardBack" | "workspaceRoot"> & {
  title: string;
  children: ReactNode;
}) {
  return (
    <SettingsScreen title={title} {...bar}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4 pb-12"
      >
        {children}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function TextSetting(props: {
  label: string;
  value: string;
  hint?: string;
  save: (value: string) => void | Promise<void> | "saved" | "invalid";
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving,setSaving]=useState(false);
  return (
    <SettingsSection title={props.label}>
      {props.hint && (
        <AppText className="px-4 py-2 text-foreground-muted">
          {props.hint}
        </AppText>
      )}
      <AppTextInput
        accessibilityLabel={props.label}
        multiline
        autoCapitalize="none"
        className="px-4 py-3 text-foreground"
        editable={!saving}
        value={draft ?? props.value}
        onChangeText={setDraft}
      />
      <SettingsRow
        icon="checkmark"
        label="Save"
        disabled={saving || draft === null || draft === props.value}
        onPress={async () => {
          if (draft === null || saving) return;
          setSaving(true);
          try {
            if(await props.save(draft)==="invalid")throw new Error("This value is not valid.");
            setDraft(null);
          } catch (error) {
            Alert.alert("Could not save", String(error));
          } finally {setSaving(false);}
        }}
      />
    </SettingsSection>
  );
}

export function InstructionSettings() {
  const settings = useListened(solus.personal.changes, solus.personal.current);
  return (
    <>
      {(
        [
          "extraInstructions",
          "delegationInstructions",
          "reviewGuideInstructions",
        ] as const
      ).map((key, index) => (
        <TextSetting
          key={key}
          label={
            [
              "Agent instructions",
              "Delegation instructions",
              "Review guide instructions",
            ][index]!
          }
          value={settings[key]}
          save={(value) => {
            if (solus.personal.set({ [key]: value }) === "invalid")
              throw new Error("Use at most 20,000 characters.");
          }}
        />
      ))}
      <SettingsSection>
        <SettingsSwitchRow
          label="Generate review guides when opening pull requests"
          value={settings.generatePrGuidesOnOpen}
          onValueChange={(generatePrGuidesOnOpen) =>
            solus.personal.set({ generatePrGuidesOnOpen })
          }
        />
      </SettingsSection>
    </>
  );
}

export function SolusVoice() {
  const {environments}=useSolusDirectory();
  const navigation=useNavigation();
  const { voiceDictionary } = useListened(
    solus.personal.changes,
    solus.personal.current,
  );
  return (
    <SettingsPage title="Voice">
      <TextSetting
        label="Dictation dictionary"
        hint="Enter one term per line. For alternate spellings, use Term = phrase | another phrase. Desktop and web dictation use this dictionary."
        value={voiceDictionary
          .map(
            (e) =>
              e.term + (e.aliases.length ? " = " + e.aliases.join(" | ") : ""),
          )
          .join("\n")}
        save={(text) =>
          solus.personal.set({ voiceDictionary: parseVoiceDictionary(text) })
        }
      />
    <SettingsSection title="Transcription models">{environments.filter(h=>h.connectionState==="connected").map(h=><SettingsRow key={h.environmentId} label={h.environmentLabel} icon="mic" onPress={()=>navigation.navigate("SettingsVoiceModels",{environmentId:h.environmentId})}/>)}</SettingsSection>
    </SettingsPage>
  );
}

export function SolusProviders() {
  const settings = useListened(solus.personal.changes, solus.personal.current);
  return (
    <SettingsPage title="Providers">
      {PROVIDERS.map((provider) => {
        const current = settings.defaultModels[provider.id] ?? "";
        const choices = [
          { id: "", label: "Provider default" },
          { id: "auto", label: "Auto" },
          ...modelChoices(provider.id, current).filter((m) => m.id !== "auto"),
        ];
        if (current && !choices.some((c) => c.id === current))
          choices.push({ id: current, label: current });
        return (
          <SettingsSection key={provider.id} title={provider.label}>
            {choices.map((choice, index) => (
              <ListChoiceRow
                key={choice.id}
                label={choice.label}
                separated={index > 0}
                selected={current === choice.id}
                onPress={() =>
                  solus.personal.set({
                    defaultModels: {
                      ...solus.personal.current().defaultModels,
                      [provider.id]: choice.id,
                    },
                  })
                }
              />
            ))}
          </SettingsSection>
        );
      })}
    </SettingsPage>
  );
}

export function SolusAccount() {
  const account = useListened(solus.account.changes, () => solus.account.view);
  const sync = useListened(
    solus.accountSync.changes,
    solus.accountSync.current,
  );
  const settings = useListened(
    solus.accountSync.changes,
    solus.accountSync.currentSettings,
  );
  const run = (action: Promise<void>) =>
    void action.catch((reason) => Alert.alert("Solus account", String(reason)));
  return (
    <SettingsPage title="Solus account & sync">
      <SettingsSection title="Solus Cloud">
        {account.kind === "signed-in" ? (
          <SettingsRow
            icon="person.crop.circle"
            label="Sign out"
            value={account.identity.name ?? account.identity.email}
            onPress={() =>
              Alert.alert("Sign out of Solus Cloud?", undefined, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Sign out",
                  onPress: () => run(solus.account.signOut()),
                },
              ])
            }
          />
        ) : (
          <SettingsRow
            icon="person.crop.circle"
            label={
              account.kind === "signing-in"
                ? "Cancel sign-in"
                : "Sign in to Solus Cloud"
            }
            disabled={account.kind === "loading"}
            value={account.kind === "signed-out" ? account.message : undefined}
            onPress={() =>
              account.kind === "signing-in"
                ? solus.account.cancelSignIn()
                : run(solus.account.startSignIn())
            }
          />
        )}
      </SettingsSection>
      <SettingsSection title="Settings sync">
        <AppText className="px-4 py-3 text-foreground">
          {sync.error?.message ??
            sync.error?.code ??
            SYNC_STATE_LABELS[sync.state]}
        </AppText>
        <SettingsRow
          label="Sync now"
          icon="arrow.clockwise"
          disabled={account.kind !== "signed-in" || sync.state === "loading"}
          onPress={() => run(solus.accountSync.syncNow())}
        />
      </SettingsSection>
      {settings.conflicts.map((c) => (
        <SettingsSection key={c.key} title={c.key}>
          <SettingsRow
            icon="iphone"
            label="Keep this device’s value"
            onPress={() =>
              solus.accountSync.settingsEngine.resolveConflict(
                c.key,
                "keep-mine",
              )
            }
          />
          <SettingsRow
            icon="cloud"
            label="Use synced value"
            onPress={() =>
              solus.accountSync.settingsEngine.resolveConflict(
                c.key,
                "take-theirs",
              )
            }
          />
        </SettingsSection>
      ))}
    </SettingsPage>
  );
}

export function SolusHostDetail({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId }>) {
  const id = route.params.environmentId;
  const nav = useNavigation();
  const directory = useSolusDirectory();
  const host = directory.hostsById[id];
  const state = useListened(solus.hostSettings.changes, () =>
    solus.hostSettings.stateOf(id),
  );
  useEffect(() => {
    if (host?.connectionState === "connected") void solus.hostSettings.load(id);
  }, [id, host?.connectionState]);
  return (
    <SettingsPage title={host?.environmentLabel ?? "Environment"}>
      <SettingsSection title="Connection">
        <SettingsRow
          label="Reconnect"
          icon="arrow.clockwise"
          value={host?.displayUrl}
          onPress={() => solus.connections.retry(id)}
        />
        <SettingsRow
          label="Forget environment"
          icon="trash"
          onPress={() =>
            Alert.alert("Forget this environment?", host?.environmentLabel, [
              { text: "Cancel", style: "cancel" },
              {
                text: "Forget",
                style: "destructive",
                onPress: () =>
                  void solus.registry
                    .forget(id)
                    .then(() => nearby.skipAutomaticPairing(id))
                    .then(() => nav.goBack())
                    .catch((e) =>
                      Alert.alert("Could not forget host", String(e)),
                    ),
              },
            ])
          }
        />
      </SettingsSection>
      <SettingsSection title="Host settings">
        {host?.connectionState !== "connected" || state.kind !== "loaded" ? (
          <AppText className="px-4 py-3 text-foreground">
            {host?.connectionState !== "connected"
              ? "Reconnect to read host settings."
              : state.kind === "error"
                ? state.message
                : "Loading host settings…"}
          </AppText>
        ) : (
          (
            [
              ["sessionCloudSync", "Save sessions to Solus Cloud"],
              [
                "continueSessionsAfterHostRestart",
                "Continue sessions after restart",
              ],
              ["agentAutoUpdates", "Update agent packages automatically"],
              ["analyticsEnabled", "Host analytics"],
            ] as const
          ).map(([key, label]) => (
            <SettingsSwitchRow
              key={key}
              label={label}
              disabled={!solus.connections.may(id, "host.admin")}
              value={state.settings[key]}
              onValueChange={(value) =>
                void solus.hostSettings
                  .update(id, { [key]: value })
                  .catch((e) => Alert.alert("Could not update host", String(e)))
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
