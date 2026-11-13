import { useCallback } from "react";
import { Alert, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppMetrics } from "@solus/contracts/apps";

import { useApp, useListened } from "../../../app/app-context";
import { ListRow } from "../../../components/ListRow";
import { ListRowLayout } from "../../../components/ListRowLayout";
import { SettingsActionRow } from "../../settings/components/SettingsActionRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { hourBars, hourBarsLabel, metricsRows, operationMetricLines } from "../app-activity";
import { AppDetailRow, ReadBody } from "../app-rows";
import { appStateLabel, runtimeText, versionLabel } from "../apps";
import { useAppChange, useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Overview (docs/plans/apps.md §9.2): whether the app runs, where, and on
 * which version; its runner; whether a save waits for a deploy; what the app
 * may use; the calls of the last 24 hours; and Stop or Start.
 */
export function OverviewSection({ hostId, appId, state, connected, reloadState, navigation }: AppSectionProps) {
  const app = useApp();
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label ?? null);
  const readMetrics = useCallback((api: HostApi) => api.appMetrics({ appId }), [appId]);
  const metrics = useAppRead(hostId, appId, "metrics", readMetrics);
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const { app: summary } = state;

  const setStopped = (stopped: boolean) => {
    change("run", (api) => (stopped ? api.appStop({ appId }) : api.appStart({ appId }))).then(reloadState, (cause: unknown) =>
      Alert.alert(stopped ? "Not stopped" : "Not started", errorMessage(cause)),
    );
  };

  return (
    <>
      <View className="gap-3">
        <SettingsSection title="App">
          <ListRowLayout
            icon="square.grid.2x2"
            label={appStateLabel(summary)}
            description={[hostLabel, summary.activeVersion === null ? null : versionLabel(summary.activeVersion)].filter(Boolean).join(" · ") || undefined}
          />
          <ListRowLayout icon="gauge" label="Runner" description={runtimeText(state.runtime, Date.now())} />
          {summary.hasUndeployedRevision ? (
            <ListRow
              icon="square.3.layers.3d"
              label="A save waits for a deploy"
              description="Deploy it in Versions."
              onPress={() => navigation.navigate("AppSection", { hostId, appId, section: "versions" })}
            />
          ) : null}
          {summary.stopped ? (
            <SettingsActionRow icon="play" label="Start" disabled={disabled} loading={busy === "run"} onPress={() => setStopped(false)} />
          ) : (
            <SettingsActionRow icon="stop.fill" label="Stop" disabled={disabled} loading={busy === "run"} onPress={() => setStopped(true)} />
          )}
        </SettingsSection>
        {summary.stopped ? <SettingsNote>A stopped app runs no operation, no schedule, and no workflow. Its UI still opens.</SettingsNote> : null}
        {state.permissionsNotice ? <SettingsNote>{state.permissionsNotice}</SettingsNote> : null}
      </View>
      <ReadBody read={metrics.state} connected={connected} subject="The calls of the last 24 hours" onRetry={metrics.reload}>
        {(value) => <Metrics metrics={value} />}
      </ReadBody>
    </>
  );
}

/** The last 24 hours: the numbers, one bar for each hour, and one row for each operation that was called. */
function Metrics(props: { readonly metrics: AppMetrics }) {
  const { metrics } = props;
  const now = Date.now();
  return (
    <>
      <View className="gap-3">
        <SettingsSection title="Last 24 hours">
          {metricsRows(metrics).map((row) => (
            <ListRowLayout key={row.label} label={row.label} detail={row.value} />
          ))}
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={hourBarsLabel(metrics)}
            className="h-24 flex-row items-end gap-0.5 border-t border-border-subtle px-4 py-4"
          >
            {hourBars(metrics.hours).map((bar) => (
              <View key={bar.start} className="h-full flex-1 overflow-hidden rounded-sm bg-subtle">
                <View className="absolute inset-x-0 bottom-0 bg-foreground-muted" style={{ height: `${bar.calls * 100}%` }} />
                <View className="absolute inset-x-0 bottom-0 bg-danger-foreground" style={{ height: `${bar.failed * 100}%` }} />
              </View>
            ))}
          </View>
        </SettingsSection>
        <SettingsNote>One bar for each hour, the oldest on the left. The marked part of a bar is the failed calls.</SettingsNote>
      </View>
      {metrics.operations.length > 0 ? (
        <SettingsSection title="Operations">
          {metrics.operations.map((operation, index) => (
            <AppDetailRow
              key={operation.operation}
              first={index === 0}
              title={operation.operation}
              lines={operationMetricLines(operation, now)}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
