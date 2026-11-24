import { useMemo } from "react";
import { View } from "react-native";
import type { RouteState } from "@solus/client-core/host-route-control";
import { useListened } from "@solus-mobile/app/app-context";
import { AppText } from "../components/ui/AppText";
import { StatusPill } from "../components/StatusPill";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { connectionTone } from "../features/connection/connectionTone";
import { hostRouteStates, type HostRouteStateRow } from "./host-route-states";
import { solus } from "./runtime";

/** The tones of desktop's route list: in use works, a refusal fails, a wait may fail, the rest are quiet. */
const STATE_PHASE = {
  "in-use": "connected",
  refused: "error",
  "different-server": "error",
  connecting: "reconnecting",
  "not-answering": "reconnecting",
  standby: "available",
  "not-in-use": "available",
  blocked: "available",
} as const satisfies Record<RouteState, Parameters<typeof connectionTone>[0]>;

/** Each address of a host with how it is doing now, not only the one in use (docs/plans/host-routes.md §12). */
export function HostRoutesSection({ hostId }: { hostId: string }) {
  const host = useListened(solus.registry.changes, () => solus.registry.host(hostId));
  const readiness = useListened(solus.connections.changes, () => solus.connections.readiness(hostId));
  const dialedUrl = useListened(solus.connections.changes, () => solus.connections.dialedUrl(hostId));
  const rows = useMemo(() => (host ? hostRouteStates(host, dialedUrl, readiness) : []), [host, dialedUrl, readiness]);
  if (rows.length === 0) return null;
  return (
    <SettingsSection title="Routes">
      {rows.map((row) => <RouteStateRow key={row.url} row={row} />)}
    </SettingsSection>
  );
}

function RouteStateRow({ row }: { row: HostRouteStateRow }) {
  return (
    <View accessible accessibilityLabel={`${row.kindLabel}, ${row.url}, ${row.stateText}`} className="gap-1 px-4 py-3">
      <View className="flex-row items-center gap-2">
        <AppText className="shrink text-base text-foreground">{row.kindLabel}</AppText>
        {row.state === "blocked" ? null : (
          <StatusPill {...connectionTone(STATE_PHASE[row.state])} label={row.stateText} size="compact" />
        )}
      </View>
      <AppText selectable numberOfLines={1} className="text-sm text-foreground-muted">
        {row.isLearned ? `${row.url} · found automatically` : row.url}
      </AppText>
      {row.state === "blocked" ? <AppText className="text-sm text-foreground-muted">{row.stateText}</AppText> : null}
    </View>
  );
}
