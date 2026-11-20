import { useCallback } from "react";
import { StackActions } from "@react-navigation/native";
import { Alert, View } from "react-native";

import { isAppPinned, withAppPinned } from "@solus/client-core/sidebar-apps";
import { ControlPill } from "../../../components/ControlPill";
import { appTileHue } from "@solus/client-core/app-tile";
import type { HostApi } from "@solus/client-core/host-api";
import type { AppMetrics, AppScheduleView, AppUpdate } from "@solus/contracts/apps";

import { useApp, useListened } from "../../../app/app-context";
import { AppText as Text } from "../../../components/AppText";
import { ListRow } from "../../../components/ListRow";
import { ListRowLayout } from "../../../components/ListRowLayout";
import { SettingsActionRow } from "../../settings/components/SettingsActionRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { hourBars, hourBarsLabel, metricsRows, operationMetricLines } from "../app-activity";
import {
  activeVersionDescription,
  agentAccessText,
  appMetaLine,
  recentDeployRows,
  recentFailureRows,
  RECENT_FAILURE_COUNT,
  scheduleOverviewLine,
} from "../app-overview";
import { AppDetailRow, AppListRow, AppStateMark, ReadBody } from "../app-rows";
import { scheduleTone } from "../app-schedules";
import { appProblems, appRoutesOnTop, appSectionTitle, type AppSectionId } from "../app-sections";
import { appItemState, scheduleState } from "../app-states";
import { agoText, appStateLabel, deleteConfirmation, runtimeText, versionLabel } from "../apps";
import { AppTile } from "../AppTile";
import { useAppChange, useAppRead } from "../use-app";
import { OverviewAppCard } from "./OverviewAppCard";
import { OverviewSource } from "./OverviewSource";
import type { AppSectionProps } from "./section-props";

/**
 * Overview (docs/plans/apps.md §9.2), as one Settings screen: who the app is;
 * what the owner calls it and its colour; whether it runs, for agents too, and
 * on which version and host; what needs the owner; the calls of the last 24
 * hours; the newest failed calls and deploys; the schedules; where the app
 * and its source came from; and Delete. A mark at the start of a row says how
 * the app, a call, a deploy, or a schedule stands. Agent access shows here and changes in Operations,
 * as on the desktop; Delete is here only.
 */
export function OverviewSection({ hostId, appId, state, connected, reloadState, navigation }: AppSectionProps) {
  const app = useApp();
  const pins = useListened(app.personal.changes, () => app.personal.current().sidebarApps);
  const pin = { host: hostId, appId };
  const pinned = isAppPinned(pins, pin);
  const togglePinned = () => {
    const current = app.personal.current().sidebarApps;
    app.personal.set({ sidebarApps: withAppPinned(current, pin, !isAppPinned(current, pin)) });
  };
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label ?? null);
  const hasSchedules = (state.descriptor?.schedules.length ?? 0) > 0;
  const readMetrics = useCallback((api: HostApi) => api.appMetrics({ appId }), [appId]);
  const readFailures = useCallback((api: HostApi) => api.appCalls({ appId, outcome: "failed", limit: RECENT_FAILURE_COUNT }), [appId]);
  const readVersions = useCallback((api: HostApi) => api.appVersions({ appId }), [appId]);
  // An app that declares no schedule has none to read.
  const readSchedules = useCallback(
    (api: HostApi): Promise<AppScheduleView[]> => (hasSchedules ? api.appSchedules({ appId }) : Promise.resolve([])),
    [appId, hasSchedules],
  );
  const metrics = useAppRead(hostId, appId, "metrics", readMetrics);
  const failures = useAppRead(hostId, appId, "calls", readFailures);
  const versions = useAppRead(hostId, appId, "versions", readVersions);
  const schedules = useAppRead(hostId, appId, "schedules", readSchedules);
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const { app: summary } = state;
  const problems = appProblems(summary);
  const now = Date.now();
  const openSection = (section: AppSectionId) => navigation.navigate("AppSection", { hostId, appId, section });

  const update = (patch: AppUpdate, failure: string): Promise<boolean> =>
    change("update", (api) => api.appUpdate({ appId, patch })).then(
      () => {
        reloadState();
        return true;
      },
      (cause: unknown) => {
        Alert.alert(failure, errorMessage(cause));
        return false;
      },
    );

  const setStopped = (stopped: boolean) => {
    change("run", (api) => (stopped ? api.appStop({ appId }) : api.appStart({ appId }))).then(reloadState, (cause: unknown) =>
      Alert.alert(stopped ? "Not stopped" : "Not started", errorMessage(cause)),
    );
  };

  const deleteApp = () => {
    const { title, message } = deleteConfirmation(summary.name);
    const run = () => {
      change("delete", (api) => api.appDelete({ appId })).then(
        (deleted) => {
          if (!deleted) {
            Alert.alert("Not deleted", "The host did not delete the app.");
            return;
          }
          // Every screen of the app on the stack shows an app that is gone.
          const stack = navigation.getState();
          navigation.dispatch(StackActions.pop(appRoutesOnTop(stack.routes, stack.index)));
        },
        (cause: unknown) => Alert.alert("Not deleted", errorMessage(cause)),
      );
    };
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: run },
    ]);
  };

  return (
    <>
      <View className="flex-row items-center gap-4 px-2">
        <AppTile hue={appTileHue(summary)} name={summary.name} size="large" />
        <View className="min-w-0 flex-1 gap-1">
          <Text accessibilityRole="header" className="text-xl font-t3-bold text-foreground" numberOfLines={2}>
            {summary.name}
          </Text>
          {summary.description ? (
            <Text className="text-sm text-foreground-muted" numberOfLines={3}>
              {summary.description}
            </Text>
          ) : null}
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {appMetaLine(summary, hostLabel)}
          </Text>
        </View>
        <ControlPill
          icon={pinned ? "pin.slash" : "pin"}
          accessibilityLabel={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
          onPress={togglePinned}
        />
      </View>

      <OverviewAppCard app={summary} disabled={disabled} onSave={update} />

      <View className="gap-3">
        <SettingsSection title="Status">
          <ListRowLayout
            leading={<AppStateMark mark={{ state: appItemState(summary) }} size={22} />}
            label={appStateLabel(summary)}
            description={runtimeText(state.runtime, now)}
          />
          {summary.activeVersion === null ? null : summary.stopped ? (
            <SettingsActionRow icon="play" label="Start" disabled={disabled} loading={busy === "run"} onPress={() => setStopped(false)} />
          ) : (
            <SettingsActionRow icon="stop.fill" label="Stop" tone="danger" disabled={disabled} loading={busy === "run"} onPress={() => setStopped(true)} />
          )}
          <ListRow
            icon="sparkles"
            label="Agent access"
            description={agentAccessText(summary)}
            detail={summary.agentAccess ? "On" : "Off"}
            accessibilityHint="Opens Operations, where you change it."
            onPress={() => openSection("operations")}
          />
          <ListRow
            icon="square.3.layers.3d"
            label="Version"
            description={activeVersionDescription(summary, versions.state.kind === "loaded" ? versions.state.value : null, now)}
            detail={versionLabel(summary.activeVersion)}
            onPress={() => openSection("versions")}
          />
          <ListRowLayout icon="server.rack" label="Host" detail={hostLabel ?? hostId} />
          <ListRowLayout icon="clock" label="Last call" detail={summary.lastCallAt === null ? "No calls yet" : agoText(summary.lastCallAt, now)} />
        </SettingsSection>
        {summary.stopped ? <SettingsNote>A stopped app runs no operation, no schedule, and no workflow. Its UI still opens.</SettingsNote> : null}
        {state.permissionsNotice ? <SettingsNote>{state.permissionsNotice}</SettingsNote> : null}
      </View>

      {problems.length > 0 ? (
        <SettingsSection title="Needs attention">
          {problems.map((problem, index) => (
            <AppListRow
              key={`${problem.section}:${problem.detail}`}
              first={index === 0}
              mark={{ state: "warning" }}
              title={appSectionTitle(problem.section)}
              lines={[{ text: problem.detail, tone: problem.tone }]}
              onPress={() => (problem.runId ? navigation.navigate("AppRun", { hostId, appId, runId: problem.runId }) : openSection(problem.section))}
            />
          ))}
        </SettingsSection>
      ) : null}

      <ReadBody read={metrics.state} connected={connected} subject="The calls of the last 24 hours" onRetry={metrics.reload}>
        {(value) => <Metrics metrics={value} now={now} />}
      </ReadBody>

      <ReadBody read={failures.state} connected={connected} subject="The failed calls" onRetry={failures.reload}>
        {(calls) => {
          const rows = recentFailureRows(calls, now);
          return (
            <SettingsSection title="Recent failures">
              {rows.length === 0 ? (
                <View className="px-2 py-4">
                  <SettingsNote>No call failed.</SettingsNote>
                </View>
              ) : (
                rows.map((row, index) => (
                  <AppListRow
                    key={row.callId}
                    first={index === 0}
                    mark={{ state: "failed" }}
                    title={row.title}
                    trailing={row.trailing}
                    lines={row.lines}
                    onPress={() =>
                      row.kind === "model"
                        ? navigation.navigate("AppModelCall", { hostId, appId, callId: row.callId })
                        : navigation.navigate("AppCall", { hostId, appId, callId: row.callId })
                    }
                  />
                ))
              )}
            </SettingsSection>
          );
        }}
      </ReadBody>

      <ReadBody read={versions.state} connected={connected} subject="The deploys" onRetry={versions.reload}>
        {(value) => {
          const rows = recentDeployRows(value, now);
          return (
            <SettingsSection title="Recent deploys">
              {rows.length === 0 ? (
                <View className="px-2 py-4">
                  <SettingsNote>No deploy yet.</SettingsNote>
                </View>
              ) : (
                rows.map((row, index) => (
                  <AppListRow
                    key={row.number}
                    first={index === 0}
                    mark={{ state: row.state }}
                    title={row.title}
                    lines={row.lines}
                    onPress={() => openSection("versions")}
                  />
                ))
              )}
            </SettingsSection>
          );
        }}
      </ReadBody>

      {hasSchedules ? (
        <ReadBody read={schedules.state} connected={connected} subject="The schedules" onRetry={schedules.reload}>
          {(value) =>
            value.length === 0 ? null : (
              <SettingsSection title="Schedules">
                {value.map((schedule, index) => (
                  <AppListRow
                    key={schedule.name}
                    first={index === 0}
                    mark={{ state: scheduleState(scheduleTone(schedule, summary.stopped, [])) }}
                    title={schedule.name}
                    lines={[{ text: scheduleOverviewLine(schedule, summary.stopped, now) }]}
                    onPress={() => openSection("schedules")}
                  />
                ))}
              </SettingsSection>
            )
          }
        </ReadBody>
      ) : null}

      <OverviewSource
        hostId={hostId}
        appId={appId}
        state={state}
        connected={connected}
        onOpenSessions={() => openSection("sessions")}
        onOpenSource={() => openSection("source")}
      />

      <SettingsSection title="Delete">
        <SettingsActionRow icon="trash" label="Delete app" tone="danger" disabled={disabled} loading={busy === "delete"} onPress={deleteApp} />
      </SettingsSection>
    </>
  );
}

/** The last 24 hours: the numbers, one bar for each hour, and one row for each operation that was called. */
function Metrics(props: { readonly metrics: AppMetrics; readonly now: number }) {
  const { metrics } = props;
  return (
    <>
      <View className="gap-3">
        <SettingsSection title="Last 24 hours">
          {metricsRows(metrics).map((row) => (
            <ListRowLayout key={row.label} label={row.label} detail={row.value} />
          ))}
          {metrics.calls > 0 ? (
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
          ) : null}
        </SettingsSection>
        {metrics.calls > 0 ? (
          <SettingsNote>One bar for each hour, the oldest on the left. The marked part of a bar is the failed calls.</SettingsNote>
        ) : null}
      </View>
      {metrics.operations.length > 0 ? (
        <SettingsSection title="Operations">
          {metrics.operations.map((operation, index) => (
            <AppDetailRow
              key={operation.operation}
              first={index === 0}
              title={operation.operation}
              lines={operationMetricLines(operation, props.now)}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
