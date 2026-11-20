import { isAppPinned, withAppPinned } from "@solus/client-core/sidebar-apps";
import { useApp, useListened } from "../../app/app-context";
import * as Clipboard from "expo-clipboard";
import { ActivityIndicator, Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPillMenu } from "../../components/ControlPill";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PillButton, WebhookListRow } from "../webhooks/webhook-rows";
import type { AppSectionId } from "./app-sections";
import { appListItem, EMPTY_NOTE, UNSUPPORTED_NOTE } from "./apps";
import { useApps, type HostApps } from "./use-apps";

/**
 * The Apps list (docs/plans/apps.md §9.3): the apps of one host, or of every
 * host this device knows, one section for each host. A row says the app's
 * state, its version, its failed calls of 24 hours, and how many problems
 * need the owner, and opens the app. A phone does not make an app: an agent
 * deploys it.
 */
export function AppsScreen({ navigation, route }: ScreenProps<"Apps">) {
  const onlyHostId = route.params?.hostId ?? null;
  const insets = useSafeAreaInsets();
  const { hosts, reload } = useApps(onlyHostId);

  return (
    <SettingsScreen title="Apps">
      {onlyHostId ? <HostStatusBanner hostId={onlyHostId} /> : null}
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {hosts.length === 0 ? (
          <SettingsNote>Connect to a host to see its apps.</SettingsNote>
        ) : null}
        {hosts.map((host) => (
          <HostAppsSection
            key={host.hostId}
            host={host}
            // One host is the screen's subject; several hosts are each named.
            title={onlyHostId ? "Apps" : host.label}
            onRetry={reload}
            onOpen={(appId) =>
              navigation.navigate("App", { hostId: host.hostId, appId })
            }
            onManage={(appId, section) =>
              section
                ? navigation.navigate("AppSection", {
                    hostId: host.hostId,
                    appId,
                    section,
                  })
                : navigation.navigate("AppManage", {
                    hostId: host.hostId,
                    appId,
                  })
            }
          />
        ))}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

/** The apps of one host. A host that is not connected shows no rows: old rows would read as current. */
function HostAppsSection(props: {
  readonly host: HostApps;
  readonly title: string;
  readonly onRetry: () => void;
  readonly onOpen: (appId: string) => void;
  readonly onManage: (appId: string, section?: AppSectionId) => void;
}) {
  const solus = useApp();
  const pins = useListened(solus.personal.changes, () => solus.personal.current().sidebarApps);
  const { host } = props;
  const { list } = host;
  if (list.kind === "loaded" && host.connected && list.apps.length > 0) {
    const now = Date.now();
    return (
      <SettingsSection title={props.title}>
        {list.apps.map((app, index) => {
          const item = appListItem(app, now);
          const pin = { host: host.hostId, appId: app.id };
          const pinned = isAppPinned(pins, pin);
          return (
            <ControlPillMenu
              key={app.id}
              title={app.name}
              shouldOpenOnLongPress
              actions={[
                { id: "open", title: "Open app" },
                { id: "manage", title: "Manage app" },
                { id: "activity", title: "View activity" },
                { id: "versions", title: "View versions" },
                { id: "pin", title: pinned ? "Unpin from sidebar" : "Pin to sidebar" },
                { id: "copy", title: "Copy app ID" },
              ]}
              onPressAction={({ nativeEvent }) => {
                switch (nativeEvent.event) {
                  case "open":
                    props.onOpen(app.id);
                    break;
                  case "manage":
                    props.onManage(app.id);
                    break;
                  case "activity":
                    props.onManage(app.id, "activity");
                    break;
                  case "versions":
                    props.onManage(app.id, "versions");
                    break;
                  case "pin": {
                    const current = solus.personal.current().sidebarApps;
                    solus.personal.set({ sidebarApps: withAppPinned(current, pin, !isAppPinned(current, pin)) });
                    break;
                  }
                  case "copy":
                    void Clipboard.setStringAsync(app.id).catch(() =>
                      Alert.alert("Not copied", "Could not copy app ID."),
                    );
                    break;
                }
              }}
            >
              <WebhookListRow
                first={index === 0}
                title={item.title}
                trailing={item.trailing ?? undefined}
                lines={item.lines}
                onPress={() => props.onOpen(app.id)}
              />
            </ControlPillMenu>
          );
        })}
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title={props.title}>
      <View className="gap-3 p-4">
        {!host.connected ? (
          <SettingsNote>Connect this host to see its apps.</SettingsNote>
        ) : list.kind === "unsupported" ? (
          <SettingsNote>{UNSUPPORTED_NOTE}</SettingsNote>
        ) : list.kind === "error" ? (
          <>
            <ErrorBanner message={`Apps could not be read: ${list.message}`} />
            <PillButton label="Try again" onPress={props.onRetry} />
          </>
        ) : list.kind === "loading" ? (
          <View className="items-center py-2">
            <ActivityIndicator
              accessibilityLabel="Reading apps"
              colorClassName="accent-icon-muted"
            />
          </View>
        ) : (
          <SettingsNote>{EMPTY_NOTE}</SettingsNote>
        )}
      </View>
    </SettingsSection>
  );
}
