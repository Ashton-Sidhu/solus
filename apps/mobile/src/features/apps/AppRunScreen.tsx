import { useCallback } from "react";
import { Alert, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppRunDetail } from "@solus/contracts/apps";

import { ListRowLayout } from "../../components/ListRowLayout";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { errorMessage } from "../settings/integrations";
import { WebhookListRow } from "../webhooks/webhook-rows";
import { AppDetailRow, AppPage, LoadedSection, MonoBlock, ReadBody } from "./app-rows";
import { canRunAgain, canTerminate, RUN_AGAIN_NOTE, runCallsRequest, runStateLabel, stepLines, stepStateLabel, terminateConfirmation } from "./app-runs";
import { callAgeText, callerText, callLines, untilText } from "./apps";
import { useAppChange, useAppRead } from "./use-app";

const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString();

/**
 * One run of a workflow (docs/plans/apps.md §8.3, §9.2): its state, its
 * input, its steps with their attempts, times, and results, and its log: the
 * executions of the workflow's function and the calls of its steps. The owner
 * terminates a run in progress, and starts a failed run again: the failed
 * step runs again and the finished steps do not.
 */
export function AppRunScreen({ navigation, route }: ScreenProps<"AppRun">) {
  const { hostId, appId, runId } = route.params;
  const readRun = useCallback((api: HostApi) => api.appRunRead({ appId, runId }), [appId, runId]);
  const run = useAppRead(hostId, appId, "run", readRun);
  const readCalls = useCallback((api: HostApi) => api.appCalls(runCallsRequest(appId, runId)), [appId, runId]);
  const calls = useAppRead(hostId, appId, "calls", readCalls);
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !run.connected;
  const reloadRun = run.reload;
  const now = Date.now();

  const terminate = (workflow: string) => {
    const { title, message } = terminateConfirmation(workflow);
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Terminate",
        style: "destructive",
        onPress: () => {
          change("terminate", (api) => api.appRunTerminate({ appId, runId })).then(reloadRun, (cause: unknown) =>
            Alert.alert("Not terminated", errorMessage(cause)),
          );
        },
      },
    ]);
  };

  const runAgain = () => {
    change("retry", (api) => api.appRunRetry({ appId, runId })).then(reloadRun, (cause: unknown) =>
      Alert.alert("Not started again", errorMessage(cause)),
    );
  };

  return (
    <AppPage title="Run" hostId={hostId}>
      <ReadBody read={run.state} connected={run.connected} subject="The run" onRetry={run.reload}>
        {(detail) =>
          detail === null ? (
            <SettingsNote>This run is no longer kept. The host keeps the newest 500 finished runs of each app.</SettingsNote>
          ) : (
            <>
              <RunDetail run={detail} now={now} />
              <LoadedSection
                title="Log"
                read={calls.state}
                connected={calls.connected}
                subject="The log of the run"
                empty="The call log holds nothing of this run."
                note="Each execution of the workflow's function and each call of a step is a row of the call log. A row opens its log lines and its trace."
                onRetry={calls.reload}
              >
                {(items) =>
                  items.map((call, index) => (
                    <WebhookListRow
                      key={call.id}
                      first={index === 0}
                      title={call.operation}
                      trailing={callAgeText(call, now)}
                      lines={callLines(call)}
                      onPress={() => navigation.navigate("AppCall", { hostId, appId, callId: call.id })}
                    />
                  ))
                }
              </LoadedSection>
              {canTerminate(detail) ? (
                <SettingsSection title="Stop">
                  <SettingsActionRow
                    icon="stop.fill"
                    label="Terminate"
                    tone="danger"
                    disabled={disabled}
                    loading={busy === "terminate"}
                    onPress={() => terminate(detail.workflow)}
                  />
                </SettingsSection>
              ) : null}
              {canRunAgain(detail) ? (
                <View className="gap-3">
                  <SettingsSection title="Start again">
                    <SettingsActionRow icon="arrow.clockwise" label="Run again" disabled={disabled} loading={busy === "retry"} onPress={runAgain} />
                  </SettingsSection>
                  <SettingsNote>{RUN_AGAIN_NOTE}</SettingsNote>
                </View>
              ) : null}
            </>
          )
        }
      </ReadBody>
    </AppPage>
  );
}

function RunDetail(props: { readonly run: AppRunDetail; readonly now: number }) {
  const { run, now } = props;
  return (
    <>
      <View className="gap-3">
        <SettingsSection title="Run">
          <ListRowLayout
            icon={run.state === "failed" ? "exclamationmark.triangle" : run.state === "succeeded" ? "checkmark.circle" : "flowchart"}
            label={runStateLabel(run.state)}
            description={run.workflow}
          />
          <ListRowLayout label="Started by" description={callerText(run.startedBy)} />
          <ListRowLayout label="Started" detail={formatTime(run.startedAt)} />
          {run.finishedAt !== null ? <ListRowLayout label="Ended" detail={formatTime(run.finishedAt)} /> : null}
          {run.state === "sleeping" && run.wakeAt !== null ? <ListRowLayout label="Starts again" detail={untilText(run.wakeAt, now)} /> : null}
          {run.key !== null ? <ListRowLayout label="Key" description={run.key} /> : null}
        </SettingsSection>
        {run.error ? <SettingsNote tone="danger">{run.error}</SettingsNote> : null}
      </View>

      <SettingsSection title="Input">
        <View className="p-4">
          <MonoBlock text={run.input} maxLines={40} />
        </View>
      </SettingsSection>

      {run.result !== null ? (
        <SettingsSection title="Result">
          <View className="p-4">
            <MonoBlock text={run.result} maxLines={40} />
          </View>
        </SettingsSection>
      ) : null}

      <SettingsSection title={run.steps.length > 0 ? `Steps · ${run.steps.length}` : "Steps"}>
        {run.steps.length === 0 ? (
          <View className="px-2 py-4">
            <SettingsNote>This run has no step yet.</SettingsNote>
          </View>
        ) : (
          run.steps.map((step, index) => (
            <AppDetailRow
              key={step.name}
              first={index === 0}
              title={step.name}
              trailing={stepStateLabel(step.state)}
              trailingTone={step.state === "failed" ? "danger" : "muted"}
              lines={stepLines(step, now)}
            >
              {step.result !== null ? (
                <View className="w-full gap-2">
                  <MonoBlock text={step.result} maxLines={12} />
                  {step.resultTruncated ? <SettingsNote>The result is longer than the host shows. This is its start.</SettingsNote> : null}
                </View>
              ) : null}
            </AppDetailRow>
          ))
        )}
      </SettingsSection>
    </>
  );
}
