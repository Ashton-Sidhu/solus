// Adapted from T3 Code apps/mobile/src/features/connection/CloudEnvironmentRows.tsx (MIT, see UPSTREAM.md).
import { SymbolView } from "../../components/AppSymbol";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { cn } from "../../lib/cn";
import { cloudHostState, type CloudHostState } from "../account/lib/host-scope";
import type { NativeHost } from "../hosts/host-registry";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import {
  hostConnectionStatus,
  hostMachineKind,
  type HostConnectionStatus,
} from "./lib/host-connection-status";

const STATE_STATUS = {
  stopped: { dot: "available", text: "Stopped", failed: false, retrying: false },
  starting: { dot: "connecting", text: "Starting…", failed: false, retrying: true },
  unavailable: { dot: "error", text: "Unavailable", failed: true, retrying: false },
  "no-route": { dot: "available", text: "Not reachable yet", failed: false, retrying: false },
} as const satisfies Record<Exclude<CloudHostState, "ready">, HostConnectionStatus>;

/**
 * "Solus Cloud" section: the hosts the signed-in account's directory lists,
 * with their state and loading, error, and empty states. Shared between the
 * Hosts screen and the account's hosts screen, as T3 shares its T3 Connect
 * rows. A stopped managed host offers Start where T3 offers a connect switch.
 */
export function CloudEnvironmentRows(props: {
  readonly hosts: ReadonlyArray<NativeHost>;
  readonly onOpenHost?: (host: NativeHost) => void;
  /** No directory host yet: the way to set one up. */
  readonly emptyAction?: ReactNode;
  /** Hide the "Solus Cloud" section title when the host provides its own header. */
  readonly showHeader?: boolean;
}) {
  const app = useApp();
  const directory = useListened(app.account.changes, () => app.account.directory);
  const showHeader = props.showHeader ?? true;

  return (
    <View collapsable={false} className={cn("gap-3", showHeader && "mt-5")}>
      {showHeader ? (
        <View className="px-1">
          <Text className="text-sm font-t3-bold uppercase text-foreground-muted">Solus Cloud</Text>
        </View>
      ) : null}

      {props.hosts.length > 0 ? (
        <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
          {props.hosts.map((host) => (
            <CloudEnvironmentRow
              key={host.id}
              host={host}
              onOpen={props.onOpenHost ? () => props.onOpenHost?.(host) : undefined}
            />
          ))}
        </View>
      ) : directory.kind === "loading" || directory.kind === "idle" ? (
        <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-grouped-card p-6">
          <ActivityIndicator colorClassName={"accent-icon"} />
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            Loading your Solus Cloud hosts.
          </Text>
        </View>
      ) : directory.kind === "error" ? null : (
        <View collapsable={false} className="gap-3 rounded-[24px] bg-grouped-card p-5">
          <Text className="text-sm leading-normal text-foreground-muted">
            No host is set up yet. A conversation needs a host to run its agent. Set one up in
            Solus, then pull to refresh.
          </Text>
          {props.emptyAction}
        </View>
      )}

      {/* Rendered alongside any rows: a failed read must not hide behind an
          otherwise-healthy list. */}
      {directory.kind === "error" ? (
        <View collapsable={false} className="gap-3 rounded-[24px] bg-grouped-card p-5">
          <Text className="text-base font-t3-bold text-foreground">
            Could not load Solus Cloud hosts
          </Text>
          <Text selectable className="text-sm text-foreground-muted">
            {directory.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void app.account.refreshDirectory();
            }}
            className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
          >
            <Text className="text-xs font-t3-bold text-foreground">Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function CloudEnvironmentRow(props: {
  readonly host: NativeHost;
  readonly onOpen: (() => void) | undefined;
}) {
  const app = useApp();
  const connection = useListened(app.connections.changes, () =>
    app.connections.state(props.host.id),
  );
  const [starting, setStarting] = useState(false);
  const state = cloudHostState(props.host);
  const status =
    state === "ready" ? hostConnectionStatus(props.host, connection) : STATE_STATUS[state];
  const statusText = [status.text, props.host.uplink?.ownerName].filter(Boolean).join(" · ");

  return (
    <Pressable
      accessibilityRole={props.onOpen ? "button" : undefined}
      accessibilityLabel={props.onOpen ? `Open ${props.host.label}` : undefined}
      disabled={!props.onOpen}
      onPress={props.onOpen}
    >
      <View collapsable={false} className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5">
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="min-w-0 flex-row items-center gap-2">
            <ConnectionStatusDot state={status.dot} pulse={status.retrying} size={7} />
            <EnvironmentMachineSymbol
              kind={hostMachineKind(props.host)}
              size={14}
              tintColorClassName="accent-foreground-muted"
            />
            <Text
              className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground"
              numberOfLines={1}
            >
              {props.host.label}
            </Text>
          </View>
          <Text
            className={cn(
              "min-w-0 text-xs",
              status.failed ? "text-danger-foreground" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {statusText}
          </Text>
        </View>
        {state === "stopped" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Start ${props.host.label}`}
            disabled={starting}
            onPress={() => {
              setStarting(true);
              void app.account.startManagedHost(props.host).finally(() => setStarting(false));
            }}
            className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70 disabled:opacity-50"
          >
            {starting ? (
              <ActivityIndicator colorClassName={"accent-icon"} />
            ) : (
              <Text className="text-xs font-t3-bold text-foreground">Start</Text>
            )}
          </Pressable>
        ) : null}
        {props.onOpen ? (
          <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
        ) : null}
      </View>
    </Pressable>
  );
}
