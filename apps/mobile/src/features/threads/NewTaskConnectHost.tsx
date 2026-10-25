import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hostReadinessCopy, isWaitingForHost, type HostReadinessAction } from "@solus/client-core/host-readiness";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SheetHeader } from "../../components/SheetHeader";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { RootStackParamList } from "../../navigation/routes";
import {
  ConnectCardPill,
  ConnectCardTile,
  ConnectOptionCard,
  connectCardClassName,
  SolusMarkIcon,
} from "../connection/ConnectOptionCard";
import { ConnectPanel } from "../connection/ConnectPanel";
import { isHostReadinessFailure } from "../connection/ConnectionStatusDot";
import { hostMachineKind } from "../connection/lib/host-machine";
import type { NativeHost } from "../hosts/host-registry";
import { newTaskHostGate, type NewTaskHostGate } from "./lib/new-task-host-gate";

type Navigation = NativeStackNavigationProp<RootStackParamList>;

const CONNECT_HOST_ACTION_LABELS = {
  retry: "Retry",
  start: "Start",
  "pair-again": "Pair again",
} satisfies Record<HostReadinessAction, string>;

/** Whether the new-task sheet composes or asks for a host. Saved hosts are dialed, as on the Hosts screen. */
export function useNewTaskHostGate(): NewTaskHostGate {
  const app = useApp();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  useEffect(() => {
    for (const host of hosts) app.connections.connection(host.id);
  }, [app, hosts]);
  // The last answer, so a Retry from the connect screen keeps the screen while it dials.
  const lastGate = useRef<NewTaskHostGate>("compose");
  return useListened(app.connections.changes, () =>
    (lastGate.current = newTaskHostGate(
      hosts.map((host) => app.connections.readiness(host.id)),
      lastGate.current,
    )),
  );
}

/**
 * What the new-task sheet shows in place of its composer while no host can run
 * the task (docs/plans/draft-connect-host.md): every saved host and its state,
 * and the ways to add one. The draft's text is kept, and the composer comes
 * back the moment a host connects.
 */
export function NewTaskConnectHost(props: {
  /** The text the person wrote before every host went away. */
  readonly draftText: string;
  readonly onClose: () => void;
}) {
  const app = useApp();
  const navigation = useNavigation<Navigation>();
  const insets = useSafeAreaInsets();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [failedHostId, setFailedHostId] = useState<string | null>(null);
  const [hasSeenDialing, setHasSeenDialing] = useState(false);
  const connectingHost = hosts.find((host) => host.id === connectingHostId) ?? null;
  const connectingReadiness = useListened(app.connections.changes, () =>
    connectingHostId ? app.connections.readiness(connectingHostId).readiness : null,
  );
  // With one host the headline names it and says its state, so the person knows which machine to wake.
  const onlyHostState = useListened(app.connections.changes, () =>
    hosts.length === 1 ? app.connections.readiness(hosts[0].id) : null,
  );
  const headline = connectingHost
    ? `Connecting to ${connectingHost.label}`
    : hosts.length === 0
      ? "Connect a host to start"
      : onlyHostState
        ? hostReadinessCopy(onlyHostState, hosts[0].label).headline
        : "Your hosts are offline";

  // A retry is answered by readiness: once the host has dialed and fallen back
  // to unreachable or refused, the wait is over and its card says so.
  useEffect(() => {
    if (!connectingHostId) return;
    if (connectingReadiness !== null && isWaitingForHost(connectingReadiness)) {
      setHasSeenDialing(true);
    } else if (hasSeenDialing && (connectingReadiness === "unreachable" || connectingReadiness === "refused")) {
      setFailedHostId(connectingHostId);
      setConnectingHostId(null);
    }
  }, [connectingHostId, connectingReadiness, hasSeenDialing]);

  const waitOn = (hostId: string) => {
    setFailedHostId(null);
    setHasSeenDialing(false);
    setConnectingHostId(hostId);
  };
  const runAction = (host: NativeHost, action: HostReadinessAction | null) => {
    if (action === "retry") {
      waitOn(host.id);
      app.connections.retry(host.id);
    } else if (action === "start") {
      waitOn(host.id);
      setHasSeenDialing(true);
      void app.account.startManagedHost(host).then((hasStarted) => {
        if (hasStarted) return;
        setFailedHostId(host.id);
        setConnectingHostId(null);
      });
    } else if (action === "pair-again") {
      navigation.navigate("PairHost");
    }
  };

  const body = (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="items-center px-5"
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingBottom: Math.max(insets.bottom, 18) + 18, paddingTop: 24 }}
    >
      <ConnectPanel>
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          {headline}
        </Text>
        <Text className="mt-2 mb-6 text-center text-sm text-foreground-muted">
          {connectingHost
            ? `Solus opens the composer when ${connectingHost.label} answers.`
            : hosts.length === 0
              ? "A host is a machine that has your code. Solus runs agents there."
              : "Agents run on your machines. Connect one to start."}
        </Text>

        {connectingHost ? (
          <View className="gap-2">
            <ConnectHostCard host={connectingHost} hasFailed={false} isConnecting onAction={() => {}} />
            <Pressable
              accessibilityRole="button"
              className="items-center py-2 active:opacity-70"
              onPress={() => setConnectingHostId(null)}
            >
              <Text className="text-sm font-t3-medium text-foreground-muted">Choose another host</Text>
            </Pressable>
          </View>
        ) : (
          <View className="gap-2">
            {hosts.map((host) => (
              <ConnectHostCard
                key={host.id}
                host={host}
                hasFailed={failedHostId === host.id}
                onAction={(action) => runAction(host, action)}
              />
            ))}
            {hosts.length === 0 ? (
              <>
                <ConnectOptionCard
                  icon="link"
                  title="Pair another machine"
                  detail="Install Solus there, then scan its code or enter its address."
                  onPress={() => navigation.navigate("PairHost")}
                />
                <ConnectOptionCard
                  icon="solus-mark"
                  title="Solus Cloud host"
                  detail="A machine Solus runs for your organization."
                  onPress={() => navigation.navigate("CloudHosts")}
                />
              </>
            ) : (
              <Pressable
                accessibilityRole="button"
                className="mt-2 flex-row items-center justify-center gap-1.5 py-2 active:opacity-70"
                onPress={() => navigation.navigate("PairHost")}
              >
                <SymbolView name="plus" size={13} tintColorClassName="accent-icon-muted" type="monochrome" />
                <Text className="text-sm font-t3-medium text-foreground-muted">Add host</Text>
              </Pressable>
            )}
          </View>
        )}

        {props.draftText ? (
          <View className="mt-4 flex-row items-center justify-center gap-1.5">
            <SymbolView name="square.and.pencil" size={12} tintColorClassName="accent-icon-muted" type="monochrome" />
            <Text className="flex-shrink text-xs text-foreground-muted" numberOfLines={1}>
              Draft kept: “{props.draftText}”
            </Text>
          </View>
        ) : null}
      </ConnectPanel>
    </ScreenScrollView>
  );

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <SheetHeader title="New session" onCancel={props.onClose} accessibilityLabel="Cancel new task" />
        {body}
      </View>
    );
  }
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions options={{ headerShadowVisible: false }} />
      <SheetHeader title="New session" onCancel={props.onClose} accessibilityLabel="Cancel new task" />
      {body}
    </View>
  );
}

function ConnectHostCard(props: {
  readonly host: NativeHost;
  readonly hasFailed: boolean;
  /** The person asked this host to connect, so the card waits on it. */
  readonly isConnecting?: boolean;
  readonly onAction: (action: HostReadinessAction | null) => void;
}) {
  const app = useApp();
  const state = useListened(app.connections.changes, () => app.connections.readiness(props.host.id));
  const copy = hostReadinessCopy(state, props.host.label);
  const isDialing = props.isConnecting || isWaitingForHost(state.readiness);
  // Nothing to do but wait while Solus dials, or while Solus Cloud starts the host.
  const action = isDialing ? null : copy.action;
  const detail = isDialing
    ? "Connecting…"
    : props.hasFailed && action === "retry"
      ? "Did not answer · try again"
      : copy.label;
  return (
    <Pressable
      accessibilityRole={action ? "button" : undefined}
      accessibilityLabel={action ? `${CONNECT_HOST_ACTION_LABELS[action]} ${props.host.label}` : `${props.host.label}. ${detail}`}
      disabled={!action}
      onPress={() => props.onAction(action)}
      className={connectCardClassName}
      style={{ borderWidth: StyleSheet.hairlineWidth }}
    >
      {/* No status dot: the line under the name says the state in words. */}
      <ConnectCardTile>
        {props.host.uplink?.kind === "managed" ? (
          <SolusMarkIcon size={18} />
        ) : (
          <EnvironmentMachineSymbol kind={hostMachineKind(props.host)} size={15} tintColorClassName="accent-foreground-muted" />
        )}
      </ConnectCardTile>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="min-w-0 text-[15px] font-t3-medium leading-snug text-foreground" numberOfLines={1}>
          {props.host.label}
        </Text>
        <Text
          className={cn(
            "min-w-0 text-[13px]",
            !isDialing && (isHostReadinessFailure(state) || props.hasFailed) ? "text-danger-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {detail}
        </Text>
      </View>
      {isDialing ? (
        <ActivityIndicator accessibilityLabel={`Connecting to ${props.host.label}`} colorClassName="accent-icon-muted" />
      ) : action ? (
        <ConnectCardPill label={CONNECT_HOST_ACTION_LABELS[action]} />
      ) : null}
    </Pressable>
  );
}
