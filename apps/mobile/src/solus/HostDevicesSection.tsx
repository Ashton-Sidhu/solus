import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useListened } from "@solus-mobile/app/app-context";
import {
  canChangeAccess,
  hasPairing,
  pairedDeviceRows,
  showsPairedDevices,
  type HostAccessSnapshot,
  type HostPairCode,
} from "@solus-mobile/features/settings/host-access";
import { timeLeft } from "@solus-mobile/lib/time";
import { AppText } from "../components/ui/AppText";
import { cn } from "../lib/cn";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { HostOperationError } from "./host-operation-error";
import { PairApprovalRow } from "./HostAccessSection";
import { solus } from "./runtime";

/**
 * The devices that reach a host, on Sharing & access: the paired devices (only
 * the owner reads them), **Pair a device** with its code, and the machines that
 * wait for approval. The page loads the host's access answer.
 */
export function HostDevicesSection(props: { readonly hostId: string }) {
  const { hostId } = props;
  const access = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(hostId));
  const approvals = useListened(solus.pairApprovals.changes, () =>
    solus.pairApprovals.approvalsOf(hostId),
  );
  const deciding = useListened(solus.pairApprovals.changes, () => solus.pairApprovals.deciding);
  const [now, setNow] = useState(() => Date.now());
  const loaded = access.kind === "loaded" ? access : null;
  const pair = loaded?.pair ?? null;
  const isCounting = (pair !== null && pair.expiresAt > now) || approvals.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second countdown while a code or a request is open
  useEffect(() => {
    if (!isCounting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isCounting]);
  if (loaded === null) return null;
  const mayPair = hasPairing(loaded.info) && canChangeAccess(loaded.info);
  const isOwner = showsPairedDevices(loaded.info);
  const openApprovals = approvals.filter((request) => request.expiresAt > now);
  if (!mayPair && !isOwner && openApprovals.length === 0) return null;
  return (
    <SettingsSection title="Devices">
      {isOwner ? <PairedDevices snapshot={loaded} now={now} /> : null}
      {openApprovals.map((request) => (
        <PairApprovalRow
          key={request.requestId}
          hostId={hostId}
          request={request}
          now={now}
          isDeciding={deciding.has(request.requestId)}
          separated
        />
      ))}
      {mayPair ? (
        <PairDevice
          hostId={hostId}
          pair={pair !== null && pair.expiresAt > now ? pair : null}
          isBusy={loaded.busy === "pair"}
          now={now}
        />
      ) : null}
    </SettingsSection>
  );
}

/** The devices the host paired, or why the host did not list them. Only the owner reads them. */
function PairedDevices(props: { readonly snapshot: HostAccessSnapshot; readonly now: number }) {
  const { snapshot } = props;
  if (snapshot.pairedDevicesError) {
    return (
      <AppText accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
        {snapshot.pairedDevicesError}
      </AppText>
    );
  }
  const devices = pairedDeviceRows(snapshot, props.now);
  if (devices.length === 0) {
    return <AppText className="px-4 py-3 text-sm text-foreground-muted">No devices are paired.</AppText>;
  }
  return devices.map((device, index) => (
    <View
      key={device.deviceId}
      accessible
      accessibilityLabel={`${device.label}, ${device.detail}`}
      className={cn(
        "min-h-12 flex-row items-center gap-3 px-4 py-3",
        index > 0 && "border-t border-border-subtle",
      )}
    >
      <AppText numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
        {device.label}
      </AppText>
      <AppText numberOfLines={1} className="shrink-0 text-sm text-foreground-muted">
        {device.detail}
      </AppText>
    </View>
  ));
}

/** **Pair a device**: makes a pairing code and shows it until it expires. */
function PairDevice(props: {
  readonly hostId: string;
  readonly pair: HostPairCode | null;
  readonly isBusy: boolean;
  readonly now: number;
}) {
  const { pair } = props;
  const generate = () =>
    void solus.hostAccess
      .generatePairCode(props.hostId)
      .catch((e) => Alert.alert("Could not make a code", HostOperationError.from(e).message));
  return (
    <View className="border-t border-border-subtle">
      {pair ? (
        <View className="gap-1 px-4 pt-3">
          <AppText
            selectable
            accessibilityLabel={`Pairing code ${pair.code}`}
            className="text-2xl font-t3-semibold tracking-[1.5px] text-foreground"
          >
            {pair.code}
          </AppText>
          <AppText className="text-sm text-foreground-muted">
            {timeLeft(pair.expiresAt, props.now)} · Enter it on the device you pair.
          </AppText>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={props.isBusy}
        onPress={generate}
        className="min-h-12 justify-center px-4 py-3 active:opacity-70"
      >
        <AppText className="text-base text-primary-text">
          {pair ? "New pairing code" : "Pair a device"}
        </AppText>
      </Pressable>
    </View>
  );
}
