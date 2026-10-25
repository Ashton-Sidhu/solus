import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { hostDiagnosticRows, hostDiagnosticsText } from "@solus/client-core/host-diagnostics";
import { HOST_READINESS_ACTION_LABELS, type HostReadinessAction } from "@solus/client-core/host-readiness";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import type { RootStackParamList } from "../../navigation/routes";
import { hostAsleepVeilCopy } from "../threads/lib/thread-host-chrome";

const COPY_FEEDBACK_DURATION_MS = 1200;
const MINUTE_MS = 60_000;

/**
 * What lies over a thread while its host is away (docs/plans/host-readiness.md):
 * the thread sleeps under one statement of what happened and the one thing to
 * do. The facts to find the cause or to send to support wait behind Details,
 * which starts closed. `bottomInset` keeps the content clear of the home indicator.
 */
export function HostAsleepVeil(props: { readonly hostId: string; readonly bottomInset: number }) {
  const { hostId } = props;
  const app = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const diagnostics = useListened(app.connections.changes, () => app.connections.diagnostics(hostId));
  const [isStarting, setIsStarting] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  // "Last seen 4 min ago" must not go stale while the host stays away. A thread
  // route stays mounted when hidden, so the clock runs only while it shows.
  const isFocused = useIsFocused();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isFocused) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, [isFocused]);
  const copy = hostAsleepVeilCopy(diagnostics.state, diagnostics.label, isStarting, now);
  const runAction = (next: HostReadinessAction) => {
    if (next === "retry") {
      app.connections.retry(hostId);
    } else if (next === "start") {
      const host = app.registry.host(hostId);
      if (!host) return;
      setIsStarting(true);
      void app.account.startManagedHost(host).finally(() => setIsStarting(false));
    } else {
      navigation.navigate("PairHost");
    }
  };
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1"
      contentContainerClassName="grow items-center justify-center px-6 py-10"
      contentContainerStyle={{ paddingBottom: props.bottomInset + 40 }}
    >
      {/* A plate in the canvas colour: on the scrim its edge barely shows, and
          nothing in the sleeping thread reads through the statement or its details. */}
      <View
        className={
          Platform.OS === "android"
            ? "w-full max-w-md items-center gap-2 rounded-3xl bg-thread-canvas p-6"
            : "w-full max-w-md items-center gap-2 rounded-3xl bg-screen p-6"
        }
        accessibilityLiveRegion="polite"
      >
        <View className="flex-row items-center justify-center gap-2.5">
          {copy.isDialing ? <ActivityIndicator size="small" colorClassName="accent-icon-muted" /> : null}
          <Text accessibilityRole="header" className="shrink text-center text-2xl font-t3-medium tracking-tight text-foreground">
            {copy.heading}
          </Text>
        </View>
        {copy.detail ? <Text className="text-center text-sm text-foreground-secondary">{copy.detail}</Text> : null}

        <View className="mt-4 flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: isDetailsOpen }}
            className="min-h-9 flex-row items-center gap-1.5 rounded-[10px] px-3 active:opacity-70"
            onPress={() => setIsDetailsOpen((open) => !open)}
          >
            <Text className="text-sm font-t3-medium text-foreground-secondary">Details</Text>
            <SymbolView
              name={isDetailsOpen ? "chevron.up" : "chevron.down"}
              size={14}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
          {copy.action ? (
            <Pressable
              accessibilityRole="button"
              className="min-h-9 items-center justify-center rounded-[10px] bg-primary px-4 active:opacity-80"
              onPress={() => copy.action && runAction(copy.action)}
            >
              <Text className="text-sm font-t3-medium text-primary-foreground">
                {HOST_READINESS_ACTION_LABELS[copy.action]}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {isDetailsOpen ? (
          <View className="mt-4 w-full gap-3">
            <View className="gap-1.5">
              {hostDiagnosticRows(diagnostics, now).map((row) => (
                <View key={row.label} className="flex-row gap-4">
                  <Text className="w-28 text-xs font-t3-medium text-foreground">{row.label}</Text>
                  <Text
                    selectable
                    className={row.isCode
                      ? "min-w-0 flex-1 font-mono text-xs text-foreground-secondary"
                      : "min-w-0 flex-1 text-xs text-foreground-secondary"}
                  >
                    {row.value}
                  </Text>
                </View>
              ))}
            </View>
            <View className="flex-row items-center justify-center gap-1">
              <CopyHostDetailsButton
                hostId={hostId}
                className="min-h-9 justify-center rounded-[10px] px-3 active:opacity-70"
                textClassName="text-sm font-t3-medium text-foreground-secondary"
              />
              <Pressable
                accessibilityRole="button"
                className="min-h-9 justify-center rounded-[10px] px-3 active:opacity-70"
                onPress={() => navigation.navigate("HostSettings", { hostId })}
              >
                <Text className="text-sm font-t3-medium text-foreground-secondary">Host settings</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

/** Copies the host's diagnostics as text, for a support message, and says when it did. */
export function CopyHostDetailsButton(props: {
  readonly hostId: string;
  readonly className?: string;
  readonly textClassName?: string;
}) {
  const app = useApp();
  const [isCopied, setIsCopied] = useState(false);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    },
    [],
  );
  const copyDetails = async () => {
    // Read at the press, so the text names the latest dial.
    const text = hostDiagnosticsText(app.connections.diagnostics(props.hostId));
    if (!(await tryCopyTextWithHaptic(text, { target: "host details" }))) {
      Alert.alert("Could not copy", "Try again.");
      return;
    }
    setIsCopied(true);
    if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = setTimeout(() => {
      setIsCopied(false);
      resetTimeoutRef.current = null;
    }, COPY_FEEDBACK_DURATION_MS);
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={isCopied ? "Copied" : "Copy host details"}
      className={props.className ?? "rounded-lg bg-subtle px-3 py-2 active:opacity-70"}
      onPress={() => void copyDetails()}
    >
      <Text className={props.textClassName ?? "text-sm text-foreground"}>{isCopied ? "Copied" : "Copy details"}</Text>
    </Pressable>
  );
}
