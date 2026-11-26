import { useState } from "react";
import { Alert, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";
import { useListened } from "@solus-mobile/app/app-context";
import { connectedApps, showsPairedDevices } from "@solus-mobile/features/settings/host-access";
import {
  connectedAppFacts,
  disconnectQuestion,
  outsideAppDirectory,
  type OutsideAppRow,
} from "@solus-mobile/features/settings/outside-app-directory";
import { appAddressesOf, cloudAppAddress } from "@solus-mobile/features/settings/app-addresses";
import { showsOutsideApps } from "@solus-mobile/features/settings/outside-app-setup";
import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
import { SymbolView } from "../components/ui/AppSymbol";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { ListRow } from "../components/ui/ListRow";
import { RowPressable } from "../components/ui/RowPressable";
import { Sheet } from "../components/ui/Sheet";
import { cn } from "../lib/cn";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { HostOperationError } from "./host-operation-error";
import { OutsideAppConnectSheet } from "./OutsideAppConnectSheet";
import { OutsideAppLogo } from "./OutsideAppLogo";
import { solus } from "./runtime";

/**
 * The directory of outside apps on Sharing & access (plans/035 §10): each cloud
 * app with its logo, who makes it, and **Connect**, or **Connected** for an app
 * that still has access. Connect opens `OutsideAppConnectSheet`; a connected
 * app opens its facts and Disconnect. Shown to each person who uses the host: the
 * app acts as the person who connects it. Only the owner reads the grants, so only
 * the owner sees Connected.
 */
export function OutsideAppsSection(props: { readonly hostId: string; readonly hostName: string }) {
  const { hostId, hostName } = props;
  const access = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(hostId));
  const [connecting, setConnecting] = useState<OutsideAppGuide | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  if (access.kind === "loading" || access.kind === "error") {
    return solus.connections.may(hostId, "host.use") ? (
      <OutsideAppsPending error={access.kind === "error" ? access.message : null} />
    ) : null;
  }
  if (access.kind !== "loaded" || !showsOutsideApps(access.info)) return null;
  const isOwner = showsPairedDevices(access.info);
  const rows = outsideAppDirectory({
    apps: isOwner && !access.pairedDevicesError ? connectedApps(access.pairedDevices) : null,
    hasInternetAddress:
      access.appEndpoint && !access.appEndpointError
        ? cloudAppAddress(appAddressesOf(access.appEndpoint)) !== null
        : null,
  });
  // A disconnected app leaves the sheet: its row has no grants to show.
  const managed = rows.find((row) => row.key === managing && row.status === "connected") ?? null;
  return (
    <>
      <SettingsSection
        title="Apps"
        footer={`Each app signs in once and acts as you on ${hostName}. Cursor, Claude Code, and other apps on a computer are set up from Solus on that computer.`}
      >
        {rows.map((row, index) => (
          <AppRow
            key={row.key}
            row={row}
            separated={index > 0}
            onPress={() => {
              if (row.status === "connected") setManaging(row.key);
              else if (row.guide) setConnecting(row.guide);
            }}
          />
        ))}
      </SettingsSection>
      {connecting ? (
        <OutsideAppConnectSheet
          hostId={hostId}
          hostName={hostName}
          guide={connecting}
          onClose={() => setConnecting(null)}
        />
      ) : null}
      {managed ? (
        <ConnectedAppSheet hostId={hostId} row={managed} onClose={() => setManaging(null)} />
      ) : null}
    </>
  );
}

/** "Approve a sign-in": the check code of an app's sign-in page, for a sign-in started elsewhere. */
export function ApproveSignInSection(props: { readonly hostId: string }) {
  const access = useListened(solus.hostAccess.changes, () =>
    solus.hostAccess.stateOf(props.hostId),
  );
  if (access.kind !== "loaded" || !showsOutsideApps(access.info)) return null;
  return (
    <SettingsSection footer="When an app's sign-in page shows a check code, type it here to approve the sign-in.">
      <ListRow label="Approve a sign-in" onPress={() => solus.appSignIns.enterCode(props.hostId)} />
    </SettingsSection>
  );
}

function AppRow(props: {
  readonly row: OutsideAppRow;
  readonly separated: boolean;
  readonly onPress: () => void;
}) {
  const { row } = props;
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  const action =
    row.status === "connected" ? `${row.name}, connected` : row.status === "needs-address"
      ? `${row.name}, needs an internet address`
      : `Connect ${row.name}`;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={row.status === "connected" ? action : `${action}, ${row.line}`}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={cn("bg-grouped-card", props.separated && "border-t border-border-subtle")}
    >
      <View className="min-h-14 flex-row items-center gap-3 px-3.5 py-2.5">
        <OutsideAppLogo logoId={row.logoId} size={36} />
        <View className="min-w-0 flex-1 gap-px">
          <AppText numberOfLines={1} className="text-base font-t3-medium text-foreground">
            {row.name}
          </AppText>
          <AppText
            numberOfLines={1}
            className={cn(
              "text-sm",
              row.status === "connected" ? "text-adaptive-emerald-600-400" : "text-foreground-muted",
            )}
          >
            {row.line}
          </AppText>
        </View>
        {row.status === "connected" ? (
          <SymbolView
            name="chevron.right"
            size={16}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        ) : row.status === "needs-address" ? (
          <AppText className="text-sm text-foreground-muted">Needs address</AppText>
        ) : (
          <View className="rounded-full bg-subtle-strong px-3 py-1.5">
            <AppText className="text-sm font-t3-semibold text-foreground">Connect</AppText>
          </View>
        )}
      </View>
    </RowPressable>
  );
}

/** A connected app: when it signed in, when it last used the host, what it can do, and Disconnect. */
function ConnectedAppSheet(props: {
  readonly hostId: string;
  readonly row: OutsideAppRow;
  readonly onClose: () => void;
}) {
  const { row } = props;
  const insets = useSafeAreaInsets();
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const facts = connectedAppFacts(row.grants, Date.now());
  const disconnect = () => {
    const question = disconnectQuestion(row.name, row.grants.length);
    Alert.alert(question.title, question.message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: () => {
          setIsDisconnecting(true);
          void solus.hostAccess
            .revokeDevices(
              props.hostId,
              row.grants.map((grant) => grant.deviceId),
            )
            .then(props.onClose)
            .catch((e) => {
              setIsDisconnecting(false);
              Alert.alert(`Could not disconnect ${row.name}`, HostOperationError.from(e).message);
            });
        },
      },
    ]);
  };
  return (
    <Sheet title="Connected app" dismissDisabled={isDisconnecting} onClose={props.onClose}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        <View className="flex-row items-center gap-3">
          <OutsideAppLogo logoId={row.logoId} size={44} />
          <AppText accessibilityRole="header" className="min-w-0 flex-1 text-xl font-t3-bold text-foreground">
            {row.name}
          </AppText>
        </View>
        <FactList facts={facts} />
        <Button
          label="Disconnect"
          tone="danger"
          fullWidth
          loading={isDisconnecting}
          onPress={disconnect}
        />
      </ScrollView>
    </Sheet>
  );
}

/** Label and value rows in one card, as the manage and approval sheets show them. */
export function FactList(props: { readonly facts: readonly { label: string; value: string }[] }) {
  return (
    <View className="overflow-hidden rounded-xl border border-border-subtle bg-card">
      {props.facts.map((fact, index) => (
        <View
          key={fact.label}
          accessible
          accessibilityLabel={`${fact.label}: ${fact.value}`}
          className={cn(
            "flex-row items-center justify-between gap-3 px-4 py-3",
            index > 0 && "border-t border-border-subtle",
          )}
        >
          <AppText className="text-base text-foreground-muted">{fact.label}</AppText>
          <AppText numberOfLines={1} className="shrink text-right text-base text-foreground">
            {fact.value}
          </AppText>
        </View>
      ))}
    </View>
  );
}

/** The section while the host's answer loads, or why it could not be read. */
function OutsideAppsPending(props: { readonly error: string | null }) {
  return (
    <SettingsSection title="Apps">
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
