import { useState } from "react";
import { Alert, View } from "react-native";
import { useListened } from "@solus-mobile/app/app-context";
import {
  connectedAppDetail,
  connectedApps,
  showsPairedDevices,
  type HostAccessAction,
} from "@solus-mobile/features/settings/host-access";
import {
  connectedAppName,
  showsOutsideApps,
} from "@solus-mobile/features/settings/outside-app-setup";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { ListActionRow } from "../components/ui/ListActionRow";
import { cn } from "../lib/cn";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { HostOperationError } from "./host-operation-error";
import { OutsideAppConnectSheet } from "./OutsideAppConnectSheet";
import { solus } from "./runtime";

/**
 * How outside apps that run in the cloud reach this host's tools over MCP, and
 * the apps that do (plans/035 §10). Shown to each person who uses the host: the
 * app that a person's pairing code approves acts as that person. **Connect an
 * app** opens the steps (`OutsideAppConnectSheet`). Only the owner reads and
 * revokes the connected apps.
 */
export function OutsideAppsSection(props: { readonly hostId: string; readonly hostName: string }) {
  const { hostId } = props;
  const access = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(hostId));
  const [isConnecting, setIsConnecting] = useState(false);
  if (access.kind === "loading" || access.kind === "error") {
    return solus.connections.may(hostId, "host.use") ? (
      <OutsideAppsPending error={access.kind === "error" ? access.message : null} />
    ) : null;
  }
  if (access.kind !== "loaded" || !showsOutsideApps(access.info)) return null;
  const isOwner = showsPairedDevices(access.info);
  return (
    <>
      <SettingsSection
        title="Use Solus in other apps"
        footer={
          isOwner
            ? "Apps that run in the cloud reach this host at its public address and sign in with a pairing code. Set up apps that run on a computer from Solus on that computer."
            : "Apps that run in the cloud reach this host at its public address and sign in with a pairing code. The app acts as you. The host's owner sees and revokes it."
        }
      >
        <SettingsRow
          icon="square.grid.2x2"
          label="Connect an app"
          onPress={() => setIsConnecting(true)}
        />
      </SettingsSection>
      {isConnecting ? (
        <OutsideAppConnectSheet
          hostId={hostId}
          hostName={props.hostName}
          onClose={() => setIsConnecting(false)}
        />
      ) : null}
      {isOwner ? (
        <ConnectedAppsSection
          hostId={hostId}
          apps={connectedApps(access.pairedDevices)}
          error={access.pairedDevicesError}
          busy={access.busy}
        />
      ) : null}
    </>
  );
}

/** The section while the host's answer loads, or why it could not be read. */
function OutsideAppsPending(props: { readonly error: string | null }) {
  return (
    <SettingsSection title="Use Solus in other apps">
      <AppText
        accessibilityRole={props.error ? "alert" : undefined}
        className={cn(
          "px-4 py-3 text-sm",
          props.error ? "text-danger-foreground" : "text-foreground-muted",
        )}
      >
        {props.error ?? "Loading…"}
      </AppText>
    </SettingsSection>
  );
}

/** The apps that still reach the host's tools, each with its access, its last connection, and Revoke. Only the owner reads them. */
function ConnectedAppsSection(props: {
  readonly hostId: string;
  readonly apps: ReturnType<typeof connectedApps>;
  readonly error: string | null;
  readonly busy: HostAccessAction | null;
}) {
  const fail = (error: HostOperationError) => Alert.alert("Could not revoke the app", error.message);
  const revoke = (deviceId: string, label: string) =>
    Alert.alert(`Revoke ${label}?`, "The app can no longer use this host's tools.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: () =>
          void solus.hostAccess
            .revokeDevice(props.hostId, deviceId)
            .catch((e) => fail(HostOperationError.from(e))),
      },
    ]);
  const revokeAll = () =>
    Alert.alert(
      props.apps.length === 1 ? "Revoke the connected app?" : `Revoke all ${props.apps.length} apps?`,
      "They can no longer use this host's tools. Each app must sign in again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke all",
          style: "destructive",
          onPress: () =>
            void solus.hostAccess
              .revokeDevices(
                props.hostId,
                props.apps.map((app) => app.deviceId),
              )
              .catch((e) => fail(HostOperationError.from(e))),
        },
      ],
    );
  return (
    <SettingsSection title="Connected apps">
      {props.error ? (
        <AppText accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
          {props.error}
        </AppText>
      ) : props.apps.length === 0 ? (
        <AppText className="px-4 py-3 text-sm text-foreground-muted">
          No apps are connected to this host.
        </AppText>
      ) : (
        <>
          {props.apps.map((app, index) => (
            <View
              key={app.deviceId}
              className={cn(
                "flex-row items-center gap-3 px-4 py-3",
                index > 0 && "border-t border-border-subtle",
              )}
            >
              <View
                accessible
                accessibilityLabel={[app.deviceLabel, connectedAppName(app), connectedAppDetail(app)]
                  .filter(Boolean)
                  .join(", ")}
                className="min-w-0 flex-1 gap-1"
              >
                <View className="flex-row items-baseline gap-2">
                  <AppText numberOfLines={1} className="shrink text-base text-foreground">
                    {app.deviceLabel}
                  </AppText>
                  {connectedAppName(app) ? (
                    <AppText numberOfLines={1} className="shrink-0 text-sm text-foreground-muted">
                      {connectedAppName(app)}
                    </AppText>
                  ) : null}
                </View>
                <AppText numberOfLines={1} className="text-sm text-foreground-muted">
                  {connectedAppDetail(app)}
                </AppText>
              </View>
              <Button
                label="Revoke"
                tone="danger"
                size="compact"
                disabled={props.busy !== null}
                onPress={() => revoke(app.deviceId, app.deviceLabel)}
              />
            </View>
          ))}
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon="trash"
              label="Revoke all apps"
              tone="danger"
              loading={props.busy === "revoke-apps"}
              disabled={props.busy !== null}
              onPress={revokeAll}
            />
          </View>
        </>
      )}
    </SettingsSection>
  );
}
