import { useCallback, useState } from "react";
import { Alert, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import { modelResultTree } from "@solus/client-core/model-result";
import type { AppModelCallView } from "@solus/contracts/app-models";

import { AppText as Text } from "../../components/AppText";
import { ListRowLayout } from "../../components/ListRowLayout";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { errorMessage } from "../settings/integrations";
import { PillButton } from "../webhooks/webhook-rows";
import { AppDetailRow, AppPage, AppStateMark, CopyPill, MonoBlock, ReadBody } from "./app-rows";
import {
  canCancelModelCall, isLongPrompt, modelCallDurationText, modelCallResultText, modelCallStateLabel, modelCallTokensText, modelStepStateLabel,
} from "./app-models";
import { modelCallState, modelStepState } from "./app-states";
import { ModelResultView } from "./ModelResultView";
import { callerText } from "./apps";
import { useAppChange, useAppRead } from "./use-app";

const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString();

/**
 * One model call (docs/plans/app-models.md §7): its state, the model, the
 * prompt, the operations the model called, what it wrote, and its result or
 * error. A running call reads again as it writes. The owner cancels a call
 * that has not ended.
 */
export function AppModelCallScreen({ route }: ScreenProps<"AppModelCall">) {
  const { hostId, appId, callId } = route.params;
  const readCall = useCallback((api: HostApi) => api.appModelCallRead({ appId, callId }), [appId, callId]);
  const call = useAppRead(hostId, appId, "modelCall", readCall);
  const { busy, change } = useAppChange(hostId);
  const reloadCall = call.reload;
  const now = Date.now();

  const cancel = () => {
    change("cancel", (api) => api.appModelCallCancel({ appId, callId })).then(reloadCall, (cause: unknown) =>
      Alert.alert("Not cancelled", errorMessage(cause)),
    );
  };

  return (
    <AppPage title="Model call" hostId={hostId}>
      <ReadBody read={call.state} connected={call.connected} subject="The model call" onRetry={call.reload}>
        {(detail) =>
          detail === null ? (
            <SettingsNote>This model call is no longer kept. The host keeps the newest 500 model calls of each app.</SettingsNote>
          ) : (
            <>
              <ModelCallDetail call={detail} now={now} />
              {canCancelModelCall(detail) ? (
                <SettingsSection title="Stop">
                  <SettingsActionRow
                    icon="stop.fill"
                    label="Cancel the call"
                    tone="danger"
                    disabled={busy !== null || !call.connected}
                    loading={busy === "cancel"}
                    onPress={cancel}
                  />
                </SettingsSection>
              ) : null}
            </>
          )
        }
      </ReadBody>
    </AppPage>
  );
}

function ModelCallDetail(props: { readonly call: AppModelCallView; readonly now: number }) {
  const { call, now } = props;
  const duration = modelCallDurationText(call, now);
  const tokens = modelCallTokensText(call);
  const resultJson = modelCallResultText(call.result);
  const [isPromptOpen, setPromptOpen] = useState(false);
  const [showsJson, setShowsJson] = useState(false);
  return (
    <>
      <View className="gap-3">
        <SettingsSection title="Call">
          <ListRowLayout
            leading={<AppStateMark mark={{ state: modelCallState(call.status) }} size={22} />}
            label={modelCallStateLabel(call.status)}
            description={call.setting}
          />
          <ListRowLayout label="Model" description={call.model ?? "Not chosen yet"} />
          <ListRowLayout label="Effort" detail={call.effort} />
          <ListRowLayout label="Started by" description={callerText(call.caller)} />
          <ListRowLayout label="Started" detail={formatTime(call.createdAt)} />
          {duration !== null ? <ListRowLayout label="Time" detail={duration} /> : null}
          {tokens !== null ? <ListRowLayout label="Tokens" detail={tokens} /> : null}
        </SettingsSection>
        {call.error ? <SettingsNote tone="danger">{call.error}</SettingsNote> : null}
      </View>

      <SettingsSection title="Prompt" footer="What the app asked the model.">
        <View className="gap-2 p-4">
          <Text selectable numberOfLines={isPromptOpen ? undefined : 6} className="text-sm text-foreground">
            {call.prompt}
          </Text>
          {isLongPrompt(call.prompt) ? (
            <PillButton label={isPromptOpen ? "Show less" : "Show the whole prompt"} onPress={() => setPromptOpen(!isPromptOpen)} />
          ) : null}
        </View>
      </SettingsSection>

      {call.steps.length > 0 ? (
        <SettingsSection title={`Operations · ${call.steps.length}`} footer="The app's operations the model called.">
          {call.steps.map((step, index) => (
            <AppDetailRow
              key={`${step.tool}-${step.startedAt}-${index}`}
              first={index === 0}
              mark={{ state: modelStepState(step.state), label: modelStepStateLabel(step.state) }}
              title={step.tool}
              lines={step.state === "failed" ? [{ text: step.error ?? modelStepStateLabel(step.state), tone: "danger" }] : []}
            />
          ))}
        </SettingsSection>
      ) : null}

      {call.text ? (
        <SettingsSection title="Model notes" footer="What the model wrote as it worked.">
          <View className="p-4">
            <Text selectable className="text-sm text-foreground-secondary">
              {call.text}
            </Text>
          </View>
        </SettingsSection>
      ) : null}

      {call.result !== null ? (
        <SettingsSection title="Result" footer="What the app got back.">
          <View className="gap-3 p-4">
            {showsJson ? <MonoBlock text={resultJson} maxLines={80} /> : <ModelResultView node={modelResultTree(call.result)} />}
            <View className="flex-row gap-2">
              <PillButton label={showsJson ? "Show fields" : "Show JSON"} onPress={() => setShowsJson(!showsJson)} />
              <CopyPill label="Copy" target="the result" value={resultJson} />
            </View>
          </View>
        </SettingsSection>
      ) : null}
    </>
  );
}
