import { useCallback } from "react";
import { Alert } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppScheduleView } from "@solus/contracts/apps";

import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppDetailRow, LoadedSection } from "../app-rows";
import { scheduleLines } from "../apps";
import { useAppChange, useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Schedules (docs/plans/apps.md §8.1, §9.2): the schedules the active
 * version declares. The owner pauses one, turns it on, or runs it now, and
 * sees how its last run ended.
 */
export function SchedulesSection({ hostId, appId, connected }: AppSectionProps) {
  const readSchedules = useCallback((api: HostApi) => api.appSchedules({ appId }), [appId]);
  const schedules = useAppRead(hostId, appId, "schedules", readSchedules);
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const reloadSchedules = schedules.reload;
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
      onRetry={schedules.reload}
    >
      {(items) =>
        items.map((schedule, index) => (
          <AppDetailRow
            key={schedule.name}
            first={index === 0}
            title={schedule.name}
            trailing={schedule.enabled ? "On" : "Paused"}
            lines={scheduleLines(schedule, now)}
          >
            <PillButton
              label={schedule.enabled ? "Pause" : "Turn on"}
              disabled={disabled}
              onPress={() =>
                act(schedule.enabled ? "Not paused" : "Not turned on", (api) =>
                  api.appScheduleSet({ appId, name: schedule.name, enabled: !schedule.enabled }),
                )
              }
            />
            <PillButton
              label="Run now"
              disabled={disabled}
              onPress={() => act("Not run", (api) => api.appScheduleRun({ appId, name: schedule.name }))}
            />
          </AppDetailRow>
        ))
      }
    </LoadedSection>
  );
}
