import { useEffect, useState } from "react";
import { Alert, Linking, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { useListened } from "@solus-mobile/app/app-context";
import {
  connectedAppDetail,
  connectedApps,
  showsPairedDevices,
  type HostAccessAction,
} from "@solus-mobile/features/settings/host-access";
import {
  appSetup,
  connectedAppName,
  openFirstLink,
  PHONE_APP_GUIDES,
  showsOutsideApps,
} from "@solus-mobile/features/settings/outside-app-setup";
import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
import { timeLeft } from "@solus-mobile/lib/time";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { Sheet } from "../components/ui/Sheet";
import { cn } from "../lib/cn";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { solus } from "./runtime";

/**
 * How outside apps (Claude, ChatGPT, Grok Bot, Poke) reach this host's tools
 * over MCP, and the apps that do (plans/035 §10). Shown to each person who uses
 * the host: the app that a person's pairing code approves acts as that person.
 * The phone is never the host machine, so it shows the public address only.
 * Only the owner reads and revokes the connected apps.
 */
export function OutsideAppsSection({ hostId }: { hostId: string }) {
  const access = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(hostId));
  const [now, setNow] = useState(() => Date.now());
  const [pickedApp, setPickedApp] = useState<OutsideAppGuide | null>(null);
  const appPair = access.kind === "loaded" ? access.appPair : null;
  const isCounting = appPair !== null && appPair.expiresAt > now;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second countdown while a code is open
  useEffect(() => {
    if (!isCounting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isCounting]);
  if (access.kind === "loading" || access.kind === "error") {
    return solus.connections.may(hostId, "host.use") ? (
      <OutsideAppsPending error={access.kind === "error" ? access.message : null} />
    ) : null;
  }
  if (access.kind !== "loaded" || !showsOutsideApps(access.info)) return null;
  const isOwner = showsPairedDevices(access.info);
  const publicUrl = access.appEndpoint?.publicUrl ?? null;
  const apps = connectedApps(access.pairedDevices);
  const makeCode = () =>
    void solus.hostAccess
      .createAppPairCode(hostId, 'write')
      .then(() => setNow(Date.now()))
      .catch((e) => Alert.alert("Could not make a pairing code", String(e)));
  const copy = (url: string) =>
    void Clipboard.setStringAsync(url).catch(() => Alert.alert("Could not copy the address", url));
  return (
    <>
      <SettingsSection
        title="Use Solus in other apps"
        footer={
          isOwner
            ? "Pick an app, or add this address to it. The app opens a sign-in page: approve it in Solus, or type a pairing code there."
            : "Pick an app, or add this address to it. The app opens a sign-in page: type a pairing code there. The app acts as you. The host's owner sees and revokes it."
        }
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
        {PHONE_APP_GUIDES.map((guide) => (
          <SettingsRow
            key={guide.id}
            icon="square.grid.2x2"
            label={guide.name}
            onPress={() => setPickedApp(guide)}
          />
        ))}
        {appPair && isCounting ? (
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
        <SettingsRow
          icon="link"
          label={isCounting ? "Make new pairing code" : "Make pairing code"}
          disabled={access.busy === "app-pair"}
          onPress={makeCode}
        />
      </SettingsSection>
      {pickedApp ? (
        <AppSetupSheet guide={pickedApp} publicUrl={publicUrl} onClose={() => setPickedApp(null)} />
      ) : null}
      {isOwner ? (
        <ConnectedAppsSection
          hostId={hostId}
          apps={apps}
          error={access.pairedDevicesError}
          busy={access.busy}
          now={now}
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

/** One app's setup: the action that hands it the address, its steps, and its docs. */
function AppSetupSheet(props: {
  readonly guide: OutsideAppGuide;
  readonly publicUrl: string | null;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const setup = appSetup(props.guide, props.publicUrl);
  const { docs } = props.guide;
  const run = async (copyText: string | null, links: readonly string[]) => {
    if (copyText !== null) await Clipboard.setStringAsync(copyText);
    if (links.length > 0) await openFirstLink(links, (url) => Linking.openURL(url));
  };
  return (
    <Sheet title={props.guide.name} onClose={props.onClose}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        {setup.kind === "needs-public-url" ? (
          <AppText className="text-base text-foreground">
            {props.guide.name} runs in the cloud, so it needs a host with a public address. This
            host has none.
          </AppText>
        ) : (
          <>
            {setup.message ? (
              <AppText
                selectable
                className="rounded-xl bg-grouped-card px-4 py-3 font-mono text-sm text-foreground"
              >
                {setup.message}
              </AppText>
            ) : null}
            <Button
              label={setup.action.label}
              tone="primary"
              fullWidth
              onPress={() =>
                void run(setup.action.copyText, setup.action.links).catch((e) =>
                  Alert.alert(`Could not open ${props.guide.name}`, String(e)),
                )
              }
            />
            <View className="gap-2">
              {props.guide.steps.map((step, index) => (
                <AppText key={step} className="text-sm text-foreground-muted">
                  {index + 1}. {step}
                </AppText>
              ))}
            </View>
          </>
        )}
        {docs ? (
          <Button
            label={`${props.guide.name} docs`}
            tone="text"
            onPress={() =>
              void Linking.openURL(docs).catch((e) =>
                Alert.alert("Could not open the docs", String(e)),
              )
            }
          />
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

/** The apps that still reach the host's tools, each with its access and Revoke. Only the owner reads them. */
function ConnectedAppsSection(props: {
  readonly hostId: string;
  readonly apps: ReturnType<typeof connectedApps>;
  readonly error: string | null;
  readonly busy: HostAccessAction | null;
  readonly now: number;
}) {
  const revoke = (deviceId: string, label: string) =>
    Alert.alert(`Revoke ${label}?`, "The app can no longer use this host's tools.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: () =>
          void solus.hostAccess
            .revokeDevice(props.hostId, deviceId)
            .catch((e) => Alert.alert("Could not revoke the app", String(e))),
      },
    ]);
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
        props.apps.map((app, index) => (
          <View
            key={app.deviceId}
            className={cn(
              "flex-row items-center gap-3 px-4 py-3",
              index > 0 && "border-t border-border-subtle",
            )}
          >
            <View
              accessible
              accessibilityLabel={[
                app.deviceLabel,
                connectedAppName(app),
                connectedAppDetail(app, props.now),
              ]
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
                {connectedAppDetail(app, props.now)}
              </AppText>
            </View>
            <Button
              label="Revoke"
              tone="danger"
              size="compact"
              disabled={props.busy === `revoke:${app.deviceId}`}
              onPress={() => revoke(app.deviceId, app.deviceLabel)}
            />
          </View>
        ))
      )}
    </SettingsSection>
  );
}
