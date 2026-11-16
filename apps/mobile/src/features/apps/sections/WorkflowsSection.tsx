import { useCallback, useState } from "react";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppRunState } from "@solus/contracts/apps";

import { relativeTime } from "../../../lib/time";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { AppListRow, FilterChips, LoadedSection } from "../app-rows";
import { RUN_STATE_CHOICES, runLines, runsRequest, runStateLabel } from "../app-runs";
// The section's own `runState` is the state the list is narrowed to.
import { runState as runItemState } from "../app-states";
import { useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Workflows (docs/plans/apps.md §8.3, §9.2): the runs of the app's
 * workflows, newest first, narrowed by state. The mark of a row says how the
 * run stands. A run opens its steps, where the owner terminates it or starts
 * it again.
 */
export function WorkflowsSection({ hostId, appId, state, connected, navigation }: AppSectionProps) {
  const [runState, setRunState] = useState<AppRunState | null>(null);
  const readRuns = useCallback((api: HostApi) => api.appRuns(runsRequest(appId, runState)), [appId, runState]);
  const runs = useAppRead(hostId, appId, "runs", readRuns);
  const now = Date.now();
  const declared = state.descriptor?.workflows ?? [];

  return (
    <>
      <FilterChips label="Filter by state" choices={RUN_STATE_CHOICES} selected={runState} onSelect={setRunState} />
      <LoadedSection
        title="Runs"
        read={runs.state}
        connected={connected}
        subject="The runs"
        empty={
          runState !== null
            ? `No run is ${runStateLabel(runState).toLowerCase()}.`
            : declared.length === 0
              ? "This app declares no workflow."
              : "No runs yet. A mutation of the app starts a run."
        }
        note="The host keeps the runs in progress and the newest 500 finished runs of each app."
        onRetry={runs.reload}
      >
        {(items) =>
          items.map((run, index) => (
            <AppListRow
              key={run.id}
              first={index === 0}
              mark={{ state: runItemState(run.state) }}
              title={run.workflow}
              trailing={relativeTime(new Date(run.startedAt).toISOString(), now)}
              lines={runLines(run, now)}
              onPress={() => navigation.navigate("AppRun", { hostId, appId, runId: run.id })}
            />
          ))
        }
      </LoadedSection>
      {state.app.stopped ? <SettingsNote>This app is stopped. A run waits until you start the app.</SettingsNote> : null}
    </>
  );
}
