// Adapted from T3 Code apps/mobile/src/components/ErrorBanner.tsx and features/connection/EnvironmentConnectionNotice.tsx (MIT, see UPSTREAM.md).
import { ActivityIndicator, Pressable, View } from "react-native";
import { hostReadinessCopy, isWaitingForHost } from "@solus/client-core/host-readiness";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { CopyHostDetailsButton } from "./HostAsleepVeil";

/** Shown only when the host is not ready: its readiness in the shared words, and the way out. */
export function HostStatusBanner({ hostId }: { hostId: string }) {
  const app = useApp();
  const state = useListened(app.connections.changes, () => app.connections.readiness(hostId));
  // A saved host with no link yet has no dial to wait on: nothing to say.
  const isUndialed = useListened(app.connections.changes, () => app.connections.state(hostId) === null);
  const label = useListened(app.registry.changes, () => app.registry.host(hostId)?.label ?? "This host");
  if (state.readiness === "ready" || (state.readiness === "checking" && isUndialed)) return null;
  const copy = hostReadinessCopy(state, label);
  const message = copy.detail ? `${copy.headline}. ${copy.detail}` : copy.headline;
  const isRetrying = isWaitingForHost(state.readiness);
  // A refused host is dialed again with a new transport, so an account host can be let in again.
  const canRetry = copy.action === "retry" || state.readiness === "refused";
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
        {/* Past the grace a person may need the facts for support. */}
        {state.away ? (
          <CopyHostDetailsButton
            hostId={hostId}
            className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
            textClassName="text-xs font-t3-bold text-foreground"
          />
        ) : null}
      </View>
    </View>
  );
}
