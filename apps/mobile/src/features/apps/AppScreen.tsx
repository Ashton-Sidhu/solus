import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppOperation, AppState, AppUi } from "@solus/contracts/apps";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { errorMessage } from "../settings/integrations";
import { AppFrame } from "./AppFrame";
import { appBody, operationKindLabel, versionLabel } from "./apps";
import { useAppChange, useAppState, useHostRead } from "./use-app";

/**
 * One app (docs/plans/apps.md §9): its UI in all of the screen, under a
 * header with its name, its host, and the version that runs. The header
 * button opens the app's sheet. An app with no UI shows its operations; an
 * app with no active version shows why its deploy failed. A stopped app
 * still opens, and says that it is stopped, with Start.
 */
export function AppScreen({ navigation, route }: ScreenProps<"App">) {
  const { hostId, appId } = route.params;
  const app = useApp();
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label ?? null);
  // A connection that did not recover its server session may have missed a
  // change of the app's data, so the UI runs its queries again.
  const sessionGeneration = useListened(app.connections.changes, () => app.connections.state(hostId)?.sessionGeneration ?? 0);
  const [dataChanges, setDataChanges] = useState(0);
  const { state, connected, isDeleted, reload } = useAppState(hostId, appId, (event) => {
    if (event === "data-changed") setDataChanges((count) => count + 1);
  });
  const loaded = state.kind === "loaded" && !isDeleted ? state.value : null;

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <ScreenHeader
        title={loaded?.app.name ?? "App"}
        subtitle={[hostLabel, loaded ? versionLabel(loaded.app.activeVersion) : null].filter(Boolean).join(" · ")}
        sidebar={false}
        onBack={() => navigation.goBack()}
        actions={[
          {
            accessibilityLabel: "Manage app",
            icon: "ellipsis",
            disabled: !loaded,
            onPress: () => {
              if (loaded) navigation.navigate("AppManage", { hostId, appId: loaded.app.id });
            },
          },
        ]}
      />
      <HostStatusBanner hostId={hostId} />
      {loaded?.app.stopped ? <StoppedBanner hostId={hostId} appId={loaded.app.id} connected={connected} onStarted={reload} /> : null}
      {isDeleted ? (
        <EmptyState variant="plain" title="This app no longer exists." detail="It was deleted on its host." />
      ) : loaded ? (
        <LoadedApp key={loaded.app.id} hostId={hostId} state={loaded} dataVersion={dataChanges + sessionGeneration} />
      ) : !connected ? (
        <EmptyState variant="plain" title="This host is not connected." detail="Connect this host to open the app." />
      ) : state.kind === "error" ? (
        <EmptyState variant="plain" title="The app could not be read" detail={state.message} actionLabel="Try again" onAction={reload} />
      ) : (
        <Loading label="Reading the app" />
      )}
    </View>
  );
}

/** A stopped app says so above its UI, with the way back. */
function StoppedBanner(props: {
  readonly hostId: string;
  readonly appId: string;
  readonly connected: boolean;
  readonly onStarted: () => void;
}) {
  const { appId } = props;
  const { busy, change } = useAppChange(props.hostId);
  const disabled = busy !== null || !props.connected;
  const start = () => {
    change("start", (api) => api.appStart({ appId })).then(props.onStarted, (cause: unknown) =>
      Alert.alert("Not started", errorMessage(cause)),
    );
  };
  return (
    <View className="px-5 pt-2">
      <View className="flex-row items-center gap-3 rounded-2xl border border-border px-3.5 py-3">
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground-muted">
          This app is stopped. No operation runs and no schedule fires.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start this app"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={start}
          className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70 disabled:opacity-40"
        >
          <Text className="text-xs font-t3-bold text-foreground">Start</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** What the app shows under its header: the frame of its UI, its operations, or why no version runs. */
function LoadedApp(props: { readonly hostId: string; readonly state: AppState; readonly dataVersion: number }) {
  const { hostId, state } = props;
  const insets = useSafeAreaInsets();
  const shown = appBody(state);
  const recordId = state.app.id;
  // A version is immutable, so its UI is read once for each active version:
  // a reconnect does not read megabytes of the same UI again.
  const uiVersion = shown.kind === "frame" ? state.app.activeVersion : null;
  const readVersion = useRef<AppUi | null>(null);
  const readUi = useCallback(
    async (api: HostApi): Promise<AppUi | null> => {
      if (uiVersion === null) return null;
      if (readVersion.current?.version === uiVersion) return readVersion.current;
      const next = await api.appUi({ appId: recordId });
      readVersion.current = next;
      return next;
    },
    [recordId, uiVersion],
  );
  const ui = useHostRead(hostId, readUi);

  if (shown.kind === "no-version") {
    return (
      <EmptyState
        variant="plain"
        title="No version of this app runs."
        detail={shown.error ?? "Its deploy did not succeed. Ask an agent to deploy it again."}
      />
    );
  }
  if (shown.kind === "operations") return <Operations operations={shown.operations} bottomInset={insets.bottom} />;
  if (ui.state.kind === "error") {
    return (
      <EmptyState variant="plain" title="The app's UI could not be read" detail={ui.state.message} actionLabel="Try again" onAction={ui.reload} />
    );
  }
  if (ui.state.kind === "loading") return <Loading label="Opening the app" />;
  // The host says the version has a UI and gives none: the operations still say what the app does.
  if (ui.state.value === null) return <Operations operations={state.descriptor?.operations ?? []} bottomInset={insets.bottom} />;
  return (
    <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
      <AppFrame
        hostId={hostId}
        appId={recordId}
        title={state.app.name}
        html={ui.state.value.html}
        network={state.network}
        dataVersion={props.dataVersion}
      />
    </View>
  );
}

function Loading(props: { readonly label: string }) {
  return (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator accessibilityLabel={props.label} colorClassName="accent-icon-muted" />
    </View>
  );
}

/** What an app with no UI does: its operations, for an agent, a schedule, or a webhook to call. */
function Operations(props: { readonly operations: readonly AppOperation[]; readonly bottomInset: number }) {
  return (
    <ScreenScrollView
      className="flex-1"
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(props.bottomInset, 18) + 18 }}
    >
      <SettingsNote>This app has no UI. An agent, a schedule, or a webhook calls its operations.</SettingsNote>
      {props.operations.length === 0 ? (
        <SettingsNote>This app declares no operation.</SettingsNote>
      ) : (
        <SettingsSection title="Operations">
          {props.operations.map((operation) => (
            <ListRowLayout
              key={operation.name}
              label={operation.name}
              description={operation.description || undefined}
              detail={operationKindLabel(operation.kind)}
            />
          ))}
        </SettingsSection>
      )}
    </ScreenScrollView>
  );
}
