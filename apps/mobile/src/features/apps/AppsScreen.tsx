import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PillButton, WebhookListRow } from "../webhooks/webhook-rows";
import { appListItem, EMPTY_NOTE, UNSUPPORTED_NOTE } from "./apps";
import { useApps, type HostApps } from "./use-apps";

/**
 * The Apps list (docs/plans/apps.md §9): the apps of one host, or of every
 * host this device knows, one section for each host. A row opens the app. A
 * phone does not make an app: an agent deploys it.
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
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {hosts.length === 0 ? <SettingsNote>Connect to a host to see its apps.</SettingsNote> : null}
        {hosts.map((host) => (
          <HostAppsSection
            key={host.hostId}
            host={host}
            // One host is the screen's subject; several hosts are each named.
            title={onlyHostId ? "Apps" : host.label}
            onRetry={reload}
            onOpen={(appId) => navigation.navigate("App", { hostId: host.hostId, appId })}
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
}) {
  const { host } = props;
  const { list } = host;
  if (list.kind === "loaded" && host.connected && list.apps.length > 0) {
    const now = Date.now();
    return (
      <SettingsSection title={props.title}>
        {list.apps.map((app, index) => {
          const item = appListItem(app, now);
          return (
            <WebhookListRow
              key={app.id}
              first={index === 0}
              title={item.title}
              trailing={item.trailing}
              lines={item.lines}
              onPress={() => props.onOpen(app.id)}
            />
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
            <ActivityIndicator accessibilityLabel="Reading apps" colorClassName="accent-icon-muted" />
          </View>
        ) : (
          <SettingsNote>{EMPTY_NOTE}</SettingsNote>
        )}
      </View>
    </SettingsSection>
  );
}
