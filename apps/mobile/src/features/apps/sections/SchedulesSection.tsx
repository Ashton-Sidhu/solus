import { useCallback, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppCallView, AppScheduleView } from "@solus/contracts/apps";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { cn } from "../../../lib/cn";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppStateMark, LoadedSection } from "../app-rows";
import {
  scheduleLastRunText,
  scheduleNextRunText,
  scheduleRunBars,
  scheduleRunSummary,
  scheduleRunTime,
  scheduleRuns,
  scheduleTone,
  scheduleToneLabel,
} from "../app-schedules";
import { callState, scheduleState } from "../app-states";
import { agoText, triggerText } from "../apps";
import { useAppChange, useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/** The most calls the host gives in one read: enough for the runs of several schedules. */
const SCHEDULE_CALL_LIMIT = 500;

/**
 * Schedules (docs/plans/apps.md §8.1, §9.2): one row each, with the mark of
 * its state, its cadence, its recent runs, and the age of its last run. A row
 * opens its next and last run, its controls, and its history; a run opens its
 * call.
 */
export function SchedulesSection({ hostId, appId, state, connected, navigation }: AppSectionProps) {
  const readSchedules = useCallback((api: HostApi) => api.appSchedules({ appId }), [appId]);
  const schedules = useAppRead(hostId, appId, "schedules", readSchedules);
  // The rows show without these runs; they do not wait for them.
  const readRuns = useCallback(
    (api: HostApi) => api.appCalls({ appId, callerKind: "schedule", limit: SCHEDULE_CALL_LIMIT }),
    [appId],
  );
  const runs = useAppRead(hostId, appId, "calls", readRuns);
  const calls = runs.state.kind === "loaded" ? runs.state.value : [];
  const { busy, change } = useAppChange(hostId);
  const [openName, setOpenName] = useState<string | null>(null);
  const disabled = busy !== null || !connected;
  const reloadSchedules = schedules.reload;
  const appStopped = state.app.stopped;
  const now = Date.now();

  const act = (refusal: string, run: (api: HostApi) => Promise<AppScheduleView[]>) => {
    change("schedule", run).then(reloadSchedules, (cause: unknown) => Alert.alert(refusal, errorMessage(cause)));
  };

  return (
    <LoadedSection
      title="Schedules"
      read={schedules.state}
      connected={connected}
      subject="The schedules"
      empty="This app declares no schedule."
      note="The jobs this app runs on its own. Each schedule calls a mutation at its time, with no person there."
      onRetry={schedules.reload}
    >
      {(items) =>
        items.map((schedule, index) => (
          <ScheduleRow
            key={schedule.name}
            first={index === 0}
            schedule={schedule}
            runs={scheduleRuns(calls, schedule.name)}
            appStopped={appStopped}
            disabled={disabled}
            now={now}
            isOpen={openName === schedule.name}
            onToggleOpen={() => setOpenName(openName === schedule.name ? null : schedule.name)}
            onToggleEnabled={(enabled) =>
              act(enabled ? "Not turned on" : "Not paused", (api) =>
                api.appScheduleSet({ appId, name: schedule.name, enabled }),
              )
            }
            onRunNow={() => act("Not run", (api) => api.appScheduleRun({ appId, name: schedule.name }))}
            onOpenRun={(callId) => navigation.navigate("AppCall", { hostId, appId, callId })}
          />
        ))
      }
    </LoadedSection>
  );
}

function ScheduleRow(props: {
  readonly first: boolean;
  readonly schedule: AppScheduleView;
  /** The newest first. */
  readonly runs: readonly AppCallView[];
  readonly appStopped: boolean;
  readonly disabled: boolean;
  readonly now: number;
  readonly isOpen: boolean;
  readonly onToggleOpen: () => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onRunNow: () => void;
  readonly onOpenRun: (callId: string) => void;
}) {
  const { schedule, runs, appStopped, now } = props;
  const tone = scheduleTone(schedule, appStopped, runs);
  const cadence = triggerText(schedule.trigger);
  const age = schedule.lastRunAt === null ? "" : agoText(schedule.lastRunAt, now);

  return (
    <View className={cn(!props.first && "border-t border-border-subtle")}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.isOpen }}
        accessibilityLabel={[schedule.name, scheduleToneLabel(tone), cadence, age && `last run ${age}`].filter(Boolean).join(", ")}
        onPress={props.onToggleOpen}
        className={cn("min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-subtle-strong", !schedule.enabled && "opacity-70")}
      >
        <View className="size-6 items-center justify-center">
          <AppStateMark mark={{ state: scheduleState(tone) }} />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base text-foreground" numberOfLines={1}>
            {schedule.name}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {cadence} · {schedule.run}
          </Text>
        </View>
        <RunBars runs={runs} />
        <Text
          className={cn(
            "w-14 text-right text-xs",
            schedule.lastOutcome === "failed" ? "text-danger-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {age}
        </Text>
      </Pressable>

      {props.isOpen ? (
        <View className="gap-4 px-4 pb-4 pl-[52px]">
          <View className="flex-row gap-6">
            <Fact label="Next" value={scheduleNextRunText(schedule, appStopped, now)} />
            <Fact label="Last" value={scheduleLastRunText(schedule, now)} danger={schedule.lastOutcome === "failed"} />
          </View>
          {schedule.lastOutcome === "failed" && schedule.lastError ? (
            <Text selectable className="text-sm text-danger-foreground">
              {schedule.lastError} <Text className="text-sm text-foreground-muted">A failed run does not try again.</Text>
            </Text>
          ) : null}
          <View className="flex-row items-center justify-between gap-3">
            <PillButton label="Run now" disabled={props.disabled || appStopped || tone === "running"} onPress={props.onRunNow} />
            <View className="flex-row items-center gap-2">
              <Text className="text-sm text-foreground-muted">On schedule</Text>
              <ThemedSwitch
                accessibilityLabel={`Run ${schedule.name} on its schedule`}
                disabled={props.disabled}
                value={schedule.enabled}
                onValueChange={props.onToggleEnabled}
              />
            </View>
          </View>
          <View className="gap-1">
            <Text className="text-sm font-t3-medium text-foreground-muted">History</Text>
            {runs.length === 0 ? (
              <Text className="py-1 text-sm text-foreground-muted">No runs yet. Use Run now to test it.</Text>
            ) : (
              runs.map((run) => (
                <Pressable
                  key={run.id}
                  accessibilityRole="button"
                  accessibilityHint="Opens the call"
                  onPress={() => props.onOpenRun(run.id)}
                  className="min-h-11 flex-row items-center gap-3 active:opacity-60"
                >
                  <AppStateMark mark={{ state: callState(run.outcome) }} size={14} />
                  <Text
                    className={cn(
                      "min-w-0 flex-1 text-sm",
                      run.outcome === "failed" ? "text-danger-foreground" : "text-foreground",
                    )}
                    numberOfLines={1}
                  >
                    {scheduleRunSummary(run)}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{scheduleRunTime(run, now)}</Text>
                  <SymbolView name="chevron.right" size={14} tintColorClassName="accent-chevron" type="monochrome" />
                </Pressable>
              ))
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The recent runs, the oldest at the left: each bar's height is the run's time. Only a failed run has a colour. */
function RunBars(props: { readonly runs: readonly AppCallView[] }) {
  const bars = scheduleRunBars(props.runs);
  if (bars.length === 0) return null;
  return (
    <View accessible={false} className="h-5 w-16 flex-row items-end justify-end gap-[2px]">
      {bars.map((bar, index) => (
        <View
          key={bar.id}
          style={{ height: `${bar.heightPct}%` }}
          className={cn(
            "w-[2px] rounded-t-[1px]",
            bar.outcome === "failed" ? "bg-danger-foreground" : "bg-foreground-muted",
            index !== bars.length - 1 && "opacity-60",
          )}
        />
      ))}
    </View>
  );
}

function Fact(props: { readonly label: string; readonly value: string; readonly danger?: boolean }) {
  return (
    <View className="min-w-0 flex-1 gap-0.5">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className={cn("text-sm", props.danger ? "text-danger-foreground" : "text-foreground")} numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  );
}
