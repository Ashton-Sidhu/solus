import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useListened } from "@solus-mobile/app/app-context";
import {
  canChangeAccess,
  connectedAppDetail,
  connectedApps,
  showsPairedDevices,
} from "@solus-mobile/features/settings/host-access";
import { timeLeft } from "@solus-mobile/lib/time";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { cn } from "../lib/cn";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { solus } from "./runtime";

/**
 * How outside apps (Claude Desktop, Cursor, Claude Code) reach this host's tools
 * over MCP, and the apps that do (plans/035 §10). Shown to the host's owner only.
 * The phone is never the host machine, so it shows the public address only.
 */
export function OutsideAppsSection({ hostId }: { hostId: string }) {
  const access = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(hostId));
  const [now, setNow] = useState(() => Date.now());
  const appPair = access.kind === "loaded" ? access.appPair : null;
  const isCounting = appPair !== null && appPair.expiresAt > now;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second countdown while a code is open
  useEffect(() => {
    if (!isCounting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isCounting]);
  if (access.kind !== "loaded" || !showsPairedDevices(access.info)) return null;
  const publicUrl = access.appEndpoint?.publicUrl ?? null;
  const apps = connectedApps(access.pairedDevices);
  const makeCode = () =>
    void solus.hostAccess
      .createAppPairCode(hostId)
      .then(() => setNow(Date.now()))
      .catch((e) => Alert.alert("Could not make a pairing code", String(e)));
  const copy = (url: string) =>
    void Clipboard.setStringAsync(url).catch(() =>
      Alert.alert("Could not copy the address", url),
    );
  const revoke = (deviceId: string, label: string) =>
    Alert.alert(`Revoke ${label}?`, "The app can no longer use this host's tools.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: () =>
          void solus.hostAccess
            .revokeDevice(hostId, deviceId)
            .catch((e) => Alert.alert("Could not revoke the app", String(e))),
      },
    ]);
  return (
    <>
      <SettingsSection
        title="Use Solus in other apps"
        footer="Add this address to the app. The app opens a sign-in page: approve it in Solus, or type a pairing code there."
      >
        {access.appEndpointError ? (
          <AppText accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
            {access.appEndpointError}
          </AppText>
        ) : publicUrl ? (
          <>
            <AppText selectable className="px-4 py-3 font-mono text-sm text-foreground">
              {publicUrl}
            </AppText>
            <SettingsRow icon="doc.on.doc" label="Copy address" onPress={() => copy(publicUrl)} />
          </>
        ) : (
          <AppText className="px-4 py-3 text-sm text-foreground-muted">
            This host has no public address. Apps on the host machine use its local address, which
            Solus on that machine shows.
          </AppText>
        )}
        {appPair && appPair.expiresAt > now ? (
          <View className="gap-1 px-4 py-3">
            <AppText
              selectable
              accessibilityLabel={`App pairing code ${appPair.code}`}
              className="font-mono text-2xl tracking-[2px] text-foreground"
            >
              {appPair.code}
            </AppText>
            <AppText className="text-sm text-foreground-muted">
              {timeLeft(appPair.expiresAt, now)} · Type it on the app's sign-in page.
            </AppText>
          </View>
        ) : null}
        {canChangeAccess(access.info) ? (
          <SettingsRow
            icon="link"
            label={appPair && appPair.expiresAt > now ? "Make new pairing code" : "Make pairing code"}
            disabled={access.busy === "app-pair"}
            onPress={makeCode}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title="Connected apps">
        {access.pairedDevicesError ? (
          <AppText accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
            {access.pairedDevicesError}
          </AppText>
        ) : apps.length === 0 ? (
          <AppText className="px-4 py-3 text-sm text-foreground-muted">
            No apps are connected to this host.
          </AppText>
        ) : (
          apps.map((app, index) => (
            <View
              key={app.deviceId}
              className={cn(
                "flex-row items-center gap-3 px-4 py-3",
                index > 0 && "border-t border-border-subtle",
              )}
            >
              <View
                accessible
                accessibilityLabel={`${app.deviceLabel}, ${connectedAppDetail(app, now)}`}
                className="min-w-0 flex-1 gap-1"
              >
                <AppText numberOfLines={1} className="text-base text-foreground">
                  {app.deviceLabel}
                </AppText>
                <AppText numberOfLines={1} className="text-sm text-foreground-muted">
                  {connectedAppDetail(app, now)}
                </AppText>
              </View>
              <Button
                label="Revoke"
                tone="danger"
                size="compact"
                disabled={access.busy === `revoke:${app.deviceId}`}
                onPress={() => revoke(app.deviceId, app.deviceLabel)}
              />
            </View>
          ))
        )}
      </SettingsSection>
    </>
  );
}
