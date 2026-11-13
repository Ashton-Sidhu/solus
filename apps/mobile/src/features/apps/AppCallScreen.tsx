import * as Clipboard from "expo-clipboard";
import { useCallback } from "react";
import { View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppCallDetail } from "@solus/contracts/apps";

import { AppText as Text } from "../../components/AppText";
import { ListRow } from "../../components/ListRow";
import { ListRowLayout } from "../../components/ListRowLayout";
import { cn } from "../../lib/cn";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { logLine, spanRows } from "./app-activity";
import { AppDetailRow, AppPage, MonoBlock, ReadBody } from "./app-rows";
import { bytesText, callerText, callOutcomeLabel, durationText } from "./apps";
import { useAppRead } from "./use-app";

const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString();

/**
 * One call of the call log (docs/plans/apps.md §9.2, decision 21): how it
 * ended, its input, its log lines, its trace in the order the spans started,
 * its error with the stack, and the run it belongs to. The host keeps no
 * result and no secret of a call, so none shows here.
 */
export function AppCallScreen({ navigation, route }: ScreenProps<"AppCall">) {
  const { hostId, appId, callId } = route.params;
  const readCall = useCallback((api: HostApi) => api.appCallRead({ appId, callId }), [appId, callId]);
  const call = useAppRead(hostId, appId, "call", readCall);
  // The webhooks name a webhook caller; the call shows without them.
  const readWebhooks = useCallback((api: HostApi) => api.appWebhooks({ appId }), [appId]);
  const webhooks = useAppRead(hostId, appId, "webhooks", readWebhooks);
  const caller = (detail: AppCallDetail) => callerText(detail.caller, webhooks.state.kind === "loaded" ? webhooks.state.value : []);

  return (
    <AppPage title="Call" hostId={hostId}>
      <ReadBody read={call.state} connected={call.connected} subject="The call" onRetry={call.reload}>
        {(detail) =>
          detail === null ? (
            <SettingsNote>This call is no longer kept. The host keeps the newest 2,000 calls of each app.</SettingsNote>
          ) : (
            <CallDetail
              call={detail}
              caller={caller(detail)}
              onOpenRun={(runId) => navigation.navigate("AppRun", { hostId, appId, runId })}
            />
          )
        }
      </ReadBody>
    </AppPage>
  );
}

function CallDetail(props: { readonly call: AppCallDetail; readonly caller: string; readonly onOpenRun: (runId: string) => void }) {
  const { call } = props;
  const { runId, traceId } = call;
  const spans = spanRows(call);
  return (
    <>
      <SettingsSection title="Call">
        <ListRowLayout
          icon={call.outcome === "failed" ? "exclamationmark.triangle" : call.outcome === "running" ? "clock" : "checkmark.circle"}
          label={callOutcomeLabel(call.outcome)}
          description={call.operation}
        />
        <ListRowLayout label="Caller" description={props.caller} />
        <ListRowLayout label="Version" detail={`v${call.version}`} />
        <ListRowLayout label="Started" detail={formatTime(call.startedAt)} />
        {call.durationMs !== null ? <ListRowLayout label="Time" detail={durationText(call.durationMs)} /> : null}
        {call.resultBytes !== null ? <ListRowLayout label="Size of the result" detail={bytesText(call.resultBytes)} /> : null}
        {runId !== null ? (
          <ListRow icon="flowchart" label="Open the run" description="This call is a part of a run of a workflow." onPress={() => props.onOpenRun(runId)} />
        ) : null}
        {traceId !== null ? (
          // The OpenTelemetry trace id: the key of this call in Insights and at a collector.
          <ListRow icon="doc.on.doc" label="Copy the trace id" description={traceId} onPress={() => { void Clipboard.setStringAsync(traceId); }} />
        ) : null}
      </SettingsSection>

      {call.error !== null ? (
        <SettingsSection title="Error">
          <View className="gap-3 p-4">
            <Text selectable className="text-sm text-danger-foreground">
              {call.error}
            </Text>
            {call.errorStack ? <MonoBlock text={call.errorStack} tone="danger" /> : null}
          </View>
        </SettingsSection>
      ) : null}

      <View className="gap-3">
        <SettingsSection title="Input">
          <View className="p-4">
            {call.input === null ? (
              <SettingsNote>The host kept no input for this call.</SettingsNote>
            ) : (
              <MonoBlock text={call.input} />
            )}
          </View>
        </SettingsSection>
        {call.inputTruncated ? <SettingsNote>The input was longer than the host keeps. This is its start.</SettingsNote> : null}
      </View>

      <View className="gap-3">
        <SettingsSection title={call.logs.length > 0 ? `Log · ${call.logs.length}` : "Log"}>
          <View className="p-4">
            {call.logs.length === 0 ? (
              <SettingsNote>This call wrote no log line.</SettingsNote>
            ) : (
              <View className="gap-1 rounded-xl bg-subtle px-3 py-2">
                {call.logs.map((entry, index) => {
                  const line = logLine(entry);
                  return (
                    <Text
                      // Two lines of a log can say the same at the same time.
                      key={`${index}:${line.text}`}
                      selectable
                      className={cn("font-mono text-xs", line.tone === "danger" ? "text-danger-foreground" : "text-foreground")}
                    >
                      {line.text}
                    </Text>
                  );
                })}
              </View>
            )}
          </View>
        </SettingsSection>
        {call.logsTruncated ? <SettingsNote>The call wrote more lines than the host keeps.</SettingsNote> : null}
      </View>

      <SettingsSection title={spans.length > 0 ? `Trace · ${spans.length}` : "Trace"}>
        {spans.length === 0 ? (
          <View className="px-2 py-4">
            <SettingsNote>This call waited for nothing: no request, no tool, no SQL, no file, and no signal.</SettingsNote>
          </View>
        ) : (
          spans.map((span, index) => (
            <AppDetailRow
              key={span.key}
              first={index === 0}
              title={span.title}
              trailing={span.trailing}
              trailingTone={span.failed ? "danger" : "muted"}
              lines={span.lines}
            >
              {/* The span in the time of the call: where it starts and how long it is. */}
              <View accessible={false} className="h-1 w-full overflow-hidden rounded-full bg-subtle">
                <View
                  className={cn("absolute inset-y-0 rounded-full", span.failed ? "bg-danger-foreground" : "bg-foreground-muted")}
                  style={{ left: `${span.offset * 100}%`, width: `${span.width * 100}%` }}
                />
              </View>
            </AppDetailRow>
          ))
        )}
      </SettingsSection>
    </>
  );
}
