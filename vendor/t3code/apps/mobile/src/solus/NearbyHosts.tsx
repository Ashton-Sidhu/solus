import { useEffect, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "../components/ui/AppText";
import { nearbyUrl } from "./discovery";
import { nearby, solus, useSolusDirectory } from "./runtime";

export function NearbyHosts({
  onSelect,
  disabled,
}: {
  onSelect: (url: string, hostId: string) => void;
  disabled: boolean;
}) {
  const { environments } = useSolusDirectory();
  const state = useSyncExternalStore(nearby.changes.subscribe, nearby.snapshot);
  useEffect(() => {
    void nearby.scan();
  }, []);
  if (!solus.canScanNearby) return null;
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between px-4">
        <AppText className="font-t3-medium">Nearby hosts</AppText>
        <Pressable
          accessibilityRole="button"
          disabled={state.scanning}
          onPress={nearby.scan}
          className="min-h-11 justify-center"
        >
          <AppText>{state.scanning ? "Scanning…" : "Scan again"}</AppText>
        </Pressable>
      </View>
      {environments.map((env) => (
        <View key={env.environmentId} className="rounded-2xl bg-grouped-card px-4 py-3">
          <AppText>{env.environmentLabel}</AppText>
          <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {env.connectionState === "connected"
              ? "Paired · Connected"
              : env.connectionError || "Paired · " + env.connectionState}
          </AppText>
        </View>
      ))}
      {state.hosts
        .filter(
          (host) =>
            !environments.some(
              (env) =>
                env.environmentId === host.installationId && env.connectionState === "connected",
            ),
        )
        .map((host) => (
          <Pressable
            key={host.installationId}
            accessibilityRole="button"
            disabled={disabled || state.scanning}
            onPress={() => onSelect(nearbyUrl(host), host.installationId)}
            className="rounded-2xl bg-grouped-card px-4 py-3"
          >
            <AppText>{host.name}</AppText>
            <AppText className="text-sm text-foreground-muted">{nearbyUrl(host)}</AppText>
          </Pressable>
        ))}
      {!state.scanning && !state.hosts.length && (!environments.length || state.error) && (
        <AppText className="px-4 text-sm text-foreground-muted">
          {state.error ?? "No unpaired hosts found."}
        </AppText>
      )}
    </View>
  );
}
