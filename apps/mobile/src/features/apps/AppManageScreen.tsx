import { StackActions, useFocusEffect } from "@react-navigation/native";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppScheduleView, AppSecretState, AppState } from "@solus/contracts/apps";

import { useApp, useListened } from "../../app/app-context";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ListRowLayout } from "../../components/ListRowLayout";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { errorMessage } from "../settings/integrations";
import { PillButton } from "../webhooks/webhook-rows";
import { CallsSection, SchedulesSection, SecretsSection, SessionsSection, VersionsSection, WebhooksSection } from "./AppManageSections";
import { deleteConfirmation, makeActiveConfirmation, versionLabel } from "./apps";
import { useAppChange, useAppLists, useAppState } from "./use-app";

/**
 * The app's sheet (docs/plans/apps.md §9, the app menu): its versions, its
 * schedules, its secrets, its webhooks, its call log, and its linked
 * sessions, with Stop or Start and Delete. Each way in has its way back:
 * make active, pause and turn on, set and clear, stop and start. One change
 * runs at a time; a refused change says why.
 */
export function AppManageScreen({ navigation, route }: ScreenProps<"AppManage">) {
  const { hostId, appId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label ?? null);
  const lists = useAppLists(hostId, appId);
  const { state, connected, isDeleted, reload } = useAppState(hostId, appId, lists.reloadFor);
  const { busy, change } = useAppChange(hostId);
  useFocusEffect(lists.reloadAll);
  const loaded = state.kind === "loaded" ? state.value : null;
  const disabled = busy !== null || !connected;

  /** Runs one change, then reads the app and its lists again. A refusal shows under `refusal`. */
  const act = (name: string, refusal: string, run: (api: HostApi) => Promise<AppState | AppScheduleView[]>) => {
    change(name, run).then(
      () => {
        reload();
        lists.reloadAll();
      },
      (cause: unknown) => Alert.alert(refusal, errorMessage(cause)),
    );
  };

  const makeActive = (version: number) => {
    const { title, message } = makeActiveConfirmation(version);
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Make active", onPress: () => act("activate", "Not made active", (api) => api.appActivate({ appId, version })) },
    ]);
  };

  const clearSecret = (secret: AppSecretState) => {
    Alert.alert(`Clear ${secret.label}?`, "The app runs without this value until you set it again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => act("secret", "Not cleared", (api) => api.appSecretSet({ appId, name: secret.name, value: null })),
      },
    ]);
  };

  const deleteApp = (name: string) => {
    const { title, message } = deleteConfirmation(name);
    const run = () => {
      change("delete", (api) => api.appDelete({ appId })).then(
        (deleted) => {
          if (!deleted) {
            Alert.alert("Not deleted", "The host did not delete the app.");
            return;
          }
          // The sheet and the app's screen under it show an app that is gone.
          navigation.dispatch(StackActions.pop(2));
        },
        (cause: unknown) => Alert.alert("Not deleted", errorMessage(cause)),
      );
    };
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: run },
    ]);
  };

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title: loaded?.app.name ?? "App" }} />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {isDeleted ? (
          <SettingsNote>This app no longer exists.</SettingsNote>
        ) : !loaded ? (
          !connected ? (
            <SettingsNote>Connect this host to see this app.</SettingsNote>
          ) : state.kind === "error" ? (
            <View className="gap-3">
              <ErrorBanner message={`The app could not be read: ${state.message}`} />
              <PillButton label="Try again" onPress={reload} />
            </View>
          ) : (
            <View className="items-center py-2">
              <ActivityIndicator accessibilityLabel="Reading the app" colorClassName="accent-icon-muted" />
            </View>
          )
        ) : (
          <>
            {!connected ? <SettingsNote>This host is not connected. What shows here can be old, and nothing can be changed.</SettingsNote> : null}
            <StateSection
              state={loaded}
              hostLabel={hostLabel}
              disabled={disabled}
              busy={busy}
              onStop={() => act("run", "Not stopped", (api) => api.appStop({ appId }))}
              onStart={() => act("run", "Not started", (api) => api.appStart({ appId }))}
            />
            <VersionsSection versions={lists.versions} disabled={disabled} onRetry={lists.reloadAll} onMakeActive={makeActive} />
            <SchedulesSection
              schedules={lists.schedules}
              disabled={disabled}
              onRetry={lists.reloadAll}
              onSetEnabled={(name, enabled) =>
                act("schedule", enabled ? "Not turned on" : "Not paused", (api) => api.appScheduleSet({ appId, name, enabled }))
              }
              onRunNow={(name) => act("schedule", "Not run", (api) => api.appScheduleRun({ appId, name }))}
            />
            <SecretsSection
              secrets={loaded.secrets}
              disabled={disabled}
              onSet={(name, value) => act("secret", "Not set", (api) => api.appSecretSet({ appId, name, value }))}
              onClear={clearSecret}
            />
            <WebhooksSection webhooks={lists.webhooks} onRetry={lists.reloadAll} />
            <CallsSection
              calls={lists.calls}
              webhooks={lists.webhooks.kind === "loaded" ? lists.webhooks.value : []}
              onRetry={lists.reloadAll}
            />
            <SessionsSection
              sessions={lists.sessions}
              onRetry={lists.reloadAll}
              // The thread takes the sheet's place, so Back returns to the app.
              onOpen={(sessionId) => navigation.dispatch(StackActions.replace("Thread", { hostId, sessionId }))}
            />
            <SettingsSection title="Delete">
              <SettingsActionRow
                icon="trash"
                label="Delete app"
                tone="danger"
                disabled={disabled}
                loading={busy === "delete"}
                onPress={() => deleteApp(loaded.app.name)}
              />
            </SettingsSection>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** What the app is, what it may use, what needs the owner, and Stop or Start. */
function StateSection(props: {
  readonly state: AppState;
  readonly hostLabel: string | null;
  readonly disabled: boolean;
  readonly busy: string | null;
  readonly onStop: () => void;
  readonly onStart: () => void;
}) {
  const { app } = props.state;
  // Stopped shows as the state of the row; the other items are what the owner must act on.
  const attention = app.attention.filter((item) => item.kind !== "stopped");
  return (
    <View className="gap-3">
      <SettingsSection title="App">
        <ListRowLayout
          icon="square.grid.2x2"
          label={app.stopped ? "Stopped" : "Running"}
          description={[props.hostLabel, versionLabel(app.activeVersion)].filter(Boolean).join(" · ")}
        />
        {app.stopped ? (
          <SettingsActionRow icon="play" label="Start" disabled={props.disabled} loading={props.busy === "run"} onPress={props.onStart} />
        ) : (
          <SettingsActionRow icon="stop.fill" label="Stop" disabled={props.disabled} loading={props.busy === "run"} onPress={props.onStop} />
        )}
      </SettingsSection>
      {app.stopped ? <SettingsNote>A stopped app runs no operation and no schedule. Its UI still opens.</SettingsNote> : null}
      {props.state.permissionsNotice ? <SettingsNote>{props.state.permissionsNotice}</SettingsNote> : null}
      {attention.map((item) => (
        <SettingsNote key={`${item.kind}:${item.detail}`} tone="danger">
          {item.detail}
        </SettingsNote>
      ))}
    </View>
  );
}
