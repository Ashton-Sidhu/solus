import { formatResourceBytes, machineCpuText, machineMemoryText, machineMemoryUsedShare, telemetrySparkline, telemetrySummaryText, telemetryUnavailableText } from "@solus/client-core/host-resource-watch";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Polyline } from "react-native-svg";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useHostResources } from "./use-host-resources";

const SPARKLINE_WIDTH = 240;
const SPARKLINE_HEIGHT = 32;

function Meter(props: { readonly label: string; readonly detail: string; readonly share: number }) {
  return (
    <View className="gap-2 px-4 py-3">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
        <Text className="min-w-0 shrink text-sm text-foreground-muted" numberOfLines={1}>{props.detail}</Text>
      </View>
      <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
        <View className="h-full rounded-full bg-primary" style={{ width: `${Math.round(Math.min(1, props.share) * 100)}%` }} />
      </View>
    </View>
  );
}

/** What this machine carries now, as the desktop's Resources tab shows it. */
export function HostResourcesScreen({ route }: ScreenProps<"HostResources">) {
  const { hostId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const host = useListened(app.registry.changes, () => app.registry.host(hostId));
  const { view, ready } = useHostResources(hostId);
  const accent = useUniwindTheme()["--color-primary"];
  const { resources, telemetry } = view;
  const sparkline = telemetry.state === "live" ? telemetrySparkline(telemetry.history, SPARKLINE_WIDTH, SPARKLINE_HEIGHT) : null;
  const sample = telemetry.state === "live" ? telemetry.sample : null;

  return (
    <SettingsScreen title={host?.label ?? "Resources"}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3">
          <SettingsSection title="This machine">
            {resources ? (
              <>
                <Meter label="CPU" detail={machineCpuText(resources)} share={resources.cpuUtilization ?? 0} />
                <Meter label="Memory" detail={machineMemoryText(resources)} share={machineMemoryUsedShare(resources)} />
              </>
            ) : (
              <View className="px-4 py-3">
                <Text className="text-base text-foreground-muted">{view.stale || !ready ? "This host does not answer." : "Reading…"}</Text>
              </View>
            )}
          </SettingsSection>
          {view.stale && resources ? <SettingsNote>The host does not answer. This is the last read.</SettingsNote> : null}
        </View>

        {telemetry.state === "hidden" ? null : (
          <View className="gap-3">
            <SettingsSection title="Solus on this machine">
              {telemetry.state === "unavailable" ? (
                <View className="px-4 py-3">
                  <Text className="text-sm text-foreground-muted">{telemetryUnavailableText(telemetry.reason)}</Text>
                </View>
              ) : !sample ? (
                <View className="px-4 py-3">
                  <Text className="text-base text-foreground-muted">Reading…</Text>
                </View>
              ) : (
                <>
                  <View className="gap-2 px-4 py-3">
                    <Text className="text-sm text-foreground-muted">{telemetrySummaryText(sample)}</Text>
                    {sparkline ? (
                      <Svg
                        accessibilityLabel="CPU use over the last five minutes"
                        height={SPARKLINE_HEIGHT}
                        viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
                        width="100%"
                        preserveAspectRatio="none"
                      >
                        <Polyline points={sparkline} fill="none" stroke={accent} strokeWidth={1.5} />
                      </Svg>
                    ) : null}
                  </View>
                  {sample.processes.map((process) => (
                    <View key={process.pid} className="flex-row items-center gap-3 border-t border-border-subtle px-4 py-2.5">
                      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>{process.name}</Text>
                      <Text className="text-sm tabular-nums text-foreground-muted">{Math.round(process.cpuPercent)}%</Text>
                      <Text className="w-20 text-right text-sm tabular-nums text-foreground-muted">{formatResourceBytes(process.residentBytes)}</Text>
                    </View>
                  ))}
                </>
              )}
            </SettingsSection>
            <SettingsNote>Solus and the agents it started.</SettingsNote>
          </View>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
