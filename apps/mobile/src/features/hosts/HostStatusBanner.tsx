// Adapted from T3 Code apps/mobile/src/components/ErrorBanner.tsx and features/connection/EnvironmentConnectionNotice.tsx (MIT, see UPSTREAM.md).
import { ActivityIndicator, Pressable, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** Shown only when the host is not connected: what is wrong and the way out. */
export function HostStatusBanner({ hostId }: { hostId: string }) {
  const app = useApp();
  const state = useListened(app.connections.changes, () => app.connections.state(hostId));
  const host = useListened(app.registry.changes, () => app.registry.host(hostId));
  if (host && (!state || state.phase === "connected")) return null;
  const message = !host
    ? "This host is no longer on this device."
    : state?.phase === "blocked"
      ? state.blockedReason === "identity-mismatch"
        ? "A different machine answered at this host's address. Solus did not connect to it."
        : host.paired
          ? "This host no longer accepts this device. Pair it again."
          : "Your account cannot reach this host now."
      : state?.phase === "offline"
        ? "The host is offline. Solus keeps trying."
        : state?.phase === "waiting-for-compute"
          ? "This host is not running."
          : state?.phase === "no-route"
            ? "This host has no address yet."
            : "Connecting to the host…";
  const isRetrying = state?.phase === "connecting" || state?.phase === "reconnecting";
  const canRetry = host && (state?.phase === "offline" || state?.phase === "blocked");
  return (
    <View className="px-5 pt-2">
      <View
        className={cn(
          "flex-row items-center gap-3 rounded-2xl px-3.5 py-3",
          isRetrying ? "bg-subtle" : "border border-danger-border bg-danger",
        )}
      >
        {isRetrying ? <ActivityIndicator size="small" colorClassName="accent-icon-muted" /> : null}
        <Text
          className={cn(
            "min-w-0 flex-1 font-t3-medium text-sm",
            isRetrying ? "text-foreground-muted" : "text-danger-foreground",
          )}
        >
          {message}
        </Text>
        {canRetry ? (
          <Pressable
            accessibilityRole="button"
            className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
            onPress={() => app.connections.retry(hostId)}
          >
            <Text className="text-xs font-t3-bold text-foreground">Retry now</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
