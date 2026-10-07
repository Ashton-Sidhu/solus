import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { cn } from "../../lib/cn";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import type { RootStackParamList } from "../../navigation/routes";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { ConnectOptionCard } from "../connection/ConnectOptionCard";
import { hostConnectionStatus, hostMachineKind } from "../connection/lib/host-connection-status";
import type { NativeHost } from "../hosts/host-registry";
import {
  CONNECT_HOST_ACTION_LABELS,
  connectHostAction,
  connectHostHeadline,
  newTaskHostGate,
  type NewTaskHostGate,
} from "./new-task-host-gate";

type Navigation = NativeStackNavigationProp<RootStackParamList>;

/** Whether the new-task sheet composes or asks for a host. Saved hosts are dialed, as on the Hosts screen. */
export function useNewTaskHostGate(): NewTaskHostGate {
  const app = useApp();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  useEffect(() => {
    for (const host of hosts) app.connections.connection(host.id);
  }, [app, hosts]);
  return useListened(app.connections.changes, () =>
    newTaskHostGate(hosts.map((host) => app.connections.state(host.id)?.phase ?? null)),
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
  const connectingPhase = useListened(app.connections.changes, () =>
    connectingHostId ? (app.connections.state(connectingHostId)?.phase ?? null) : null,
  );

  // A retry is answered by the phase: once the host has dialed and fallen back
  // to offline or blocked, the wait is over and its card says so.
  useEffect(() => {
    if (!connectingHostId) return;
    if (connectingPhase === "connecting" || connectingPhase === "reconnecting") {
      setHasSeenDialing(true);
    } else if (hasSeenDialing && (connectingPhase === "offline" || connectingPhase === "blocked")) {
      setFailedHostId(connectingHostId);
      setConnectingHostId(null);
    }
  }, [connectingHostId, connectingPhase, hasSeenDialing]);

  const waitOn = (hostId: string) => {
    setFailedHostId(null);
    setHasSeenDialing(false);
    setConnectingHostId(hostId);
  };
  const runAction = (host: NativeHost, action: ReturnType<typeof connectHostAction>) => {
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
      <View className="w-full max-w-[520px]">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          {connectHostHeadline(hosts, connectingHost?.label ?? null)}
        </Text>
        <Text className="mt-2 mb-6 text-center text-sm text-foreground-muted">
          {connectingHost
            ? `Solus opens the composer when ${connectingHost.label} answers.`
            : hosts.length === 0
              ? "A host is a machine that has your code. Solus runs agents there."
              : "Agents run on your machines. Connect one to start."}
        </Text>

        {connectingHost ? (
          <Pressable
            accessibilityRole="button"
            className="items-center py-2 active:opacity-70"
            onPress={() => setConnectingHostId(null)}
          >
            <Text className="text-sm font-t3-medium text-foreground-muted">Choose another host</Text>
          </Pressable>
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
                  icon="cloud"
                  title="Cloud host"
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
      </View>
    </ScreenScrollView>
  );

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title="New thread" hideBottomBorder onBack={props.onClose} />
        {body}
      </View>
    );
  }
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions options={{ headerBackVisible: false, headerShadowVisible: false, title: "" }} />
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button accessibilityLabel="Cancel new task" label="Cancel" onPress={props.onClose} />
      </NativeHeaderToolbar>
      {body}
    </View>
  );
}

function ConnectHostCard(props: {
  readonly host: NativeHost;
  readonly hasFailed: boolean;
  readonly onAction: (action: ReturnType<typeof connectHostAction>) => void;
}) {
  const app = useApp();
  const state = useListened(app.connections.changes, () => app.connections.state(props.host.id));
  const status = hostConnectionStatus(props.host, state);
  const action = connectHostAction(props.host, state);
  const detail = props.hasFailed && action === "retry" ? "Did not answer · try again" : status.text;
  return (
    <Pressable
      accessibilityRole={action ? "button" : undefined}
      accessibilityLabel={action ? `${CONNECT_HOST_ACTION_LABELS[action]} ${props.host.label}` : `${props.host.label}. ${detail}`}
      disabled={!action}
      onPress={() => props.onAction(action)}
      className="flex-row items-center gap-3 rounded-[24px] bg-grouped-card px-4 py-3.5 active:opacity-70"
    >
      <View className="size-9 items-center justify-center rounded-xl bg-subtle">
        <EnvironmentMachineSymbol kind={hostMachineKind(props.host)} size={15} tintColorClassName="accent-foreground-muted" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="min-w-0 flex-row items-center gap-2">
          {/* A host that never answers would pulse for ever; the dot holds still. */}
          <ConnectionStatusDot state={status.dot} pulse={false} size={7} />
          <Text className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground" numberOfLines={1}>
            {props.host.label}
          </Text>
        </View>
        <Text
          className={cn("min-w-0 text-xs", status.failed || props.hasFailed ? "text-danger-foreground" : "text-foreground-muted")}
          numberOfLines={1}
        >
          {detail}
        </Text>
      </View>
      {action ? (
        <View className="rounded-full bg-subtle px-3.5 py-2">
          <Text className="text-xs font-t3-bold text-foreground">{CONNECT_HOST_ACTION_LABELS[action]}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
