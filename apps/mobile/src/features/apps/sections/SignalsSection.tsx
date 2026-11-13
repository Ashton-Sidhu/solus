import { useCallback, useState } from "react";
import { Alert, TextInput, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppSignalActionView, AppSignalView } from "@solus/contracts/apps";

import { relativeTime } from "../../../lib/time";
import { SettingsActionRow } from "../../settings/components/SettingsActionRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppDetailRow, LoadedSection, MonoBlock, ReadBody } from "../app-rows";
import {
  ACTION_MADE_ELSEWHERE_NOTE,
  deleteActionConfirmation,
  enabledSaveRequest,
  newNotifyDraft,
  notifyDraftOf,
  notifySaveRequest,
  OCCURRENCE_LIMIT,
  occurrenceLines,
  signalActionLabel,
  signalActionLines,
  signalLines,
  TEMPLATE_NOTE,
  type NotifyDraft,
} from "../app-signals";
import { jsonText } from "../apps";
import { useAppChange, useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Signals (docs/plans/apps.md §8.4, §9.2): each signal the active version
 * declares with its payload schema and its signal actions, then the newest
 * occurrences with how each action ended. The owner adds and changes a
 * notification, and turns off, turns on, or deletes each action. An action
 * that starts agent work names a session or an automation, which the phone
 * has no picker for: it is made on desktop or on the web.
 */
export function SignalsSection({ hostId, appId, connected, navigation }: AppSectionProps) {
  const readSignals = useCallback((api: HostApi) => api.appSignals({ appId }), [appId]);
  const readOccurrences = useCallback((api: HostApi) => api.appSignalOccurrences({ appId, limit: OCCURRENCE_LIMIT }), [appId]);
  const signals = useAppRead(hostId, appId, "signals", readSignals);
  const occurrences = useAppRead(hostId, appId, "occurrences", readOccurrences);
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const [draft, setDraft] = useState<NotifyDraft | null>(null);
  const reloadSignals = signals.reload;
  const now = Date.now();

  const act = (refusal: string, run: (api: HostApi) => Promise<AppSignalView[]>, done?: () => void) => {
    change("signal", run).then(
      () => {
        done?.();
        reloadSignals();
      },
      (cause: unknown) => Alert.alert(refusal, errorMessage(cause)),
    );
  };

  const saveDraft = () => {
    if (!draft) return;
    act("Not saved", (api) => api.appSignalActionSave(notifySaveRequest(appId, draft)), () => setDraft(null));
  };

  const setEnabled = (action: AppSignalActionView, enabled: boolean) => {
    act(enabled ? "Not turned on" : "Not turned off", (api) => api.appSignalActionSave(enabledSaveRequest(appId, action, enabled)));
  };

  const deleteAction = (action: AppSignalActionView) => {
    const { title, message } = deleteActionConfirmation(action);
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => act("Not deleted", (api) => api.appSignalActionDelete({ appId, actionId: action.id })),
      },
    ]);
  };

  return (
    <>
      <ReadBody read={signals.state} connected={connected} subject="The signals" onRetry={signals.reload}>
        {(items) =>
          items.length === 0 ? (
            <SettingsNote>This app declares no signal.</SettingsNote>
          ) : (
            <>
              {items.map((signal) => (
                <SignalCard
                  key={signal.name}
                  signal={signal}
                  now={now}
                  disabled={disabled}
                  draft={draft?.signal === signal.name ? draft : null}
                  onDraft={setDraft}
                  onSave={saveDraft}
                  onSetEnabled={setEnabled}
                  onDelete={deleteAction}
                />
              ))}
              <SettingsNote>{ACTION_MADE_ELSEWHERE_NOTE}</SettingsNote>
            </>
          )
        }
      </ReadBody>
      <LoadedSection
        title="Occurrences"
        read={occurrences.state}
        connected={connected}
        subject="The occurrences"
        empty="The app emitted no signal yet."
        note="The host keeps the newest 1,000 occurrences of each app."
        onRetry={occurrences.reload}
      >
        {(items) =>
          items.map((occurrence, index) => {
            const { callId, runId } = occurrence;
            return (
              <AppDetailRow
                key={occurrence.id}
                first={index === 0}
                title={occurrence.name}
                trailing={relativeTime(new Date(occurrence.emittedAt).toISOString(), now)}
                lines={occurrenceLines(occurrence)}
              >
                {callId !== null ? (
                  <PillButton label="Open the call" onPress={() => navigation.navigate("AppCall", { hostId, appId, callId })} />
                ) : null}
                {runId !== null ? (
                  <PillButton label="Open the run" onPress={() => navigation.navigate("AppRun", { hostId, appId, runId })} />
                ) : null}
              </AppDetailRow>
            );
          })
        }
      </LoadedSection>
    </>
  );
}

/** One signal: what it means, its payload schema, its actions, and the way to add a notification. */
function SignalCard(props: {
  readonly signal: AppSignalView;
  readonly now: number;
  readonly disabled: boolean;
  /** The form that is open for this signal, or null. */
  readonly draft: NotifyDraft | null;
  readonly onDraft: (draft: NotifyDraft | null) => void;
  readonly onSave: () => void;
  readonly onSetEnabled: (action: AppSignalActionView, enabled: boolean) => void;
  readonly onDelete: (action: AppSignalActionView) => void;
}) {
  const { signal, draft } = props;
  const [schemaShown, setSchemaShown] = useState(false);
  const form = draft ? <NotifyForm draft={draft} disabled={props.disabled} onChange={props.onDraft} onSave={props.onSave} /> : null;
  return (
    <SettingsSection title={signal.name}>
      <AppDetailRow first title="Signal" lines={signalLines(signal, props.now)}>
        <PillButton label={schemaShown ? "Hide the payload schema" : "Show the payload schema"} onPress={() => setSchemaShown(!schemaShown)} />
        {schemaShown ? (
          <View className="w-full">
            <MonoBlock text={jsonText(signal.payload)} />
          </View>
        ) : null}
      </AppDetailRow>
      {signal.actions.map((action) => {
        const editable = notifyDraftOf(action);
        return (
          <AppDetailRow
            key={action.id}
            first={false}
            title={signalActionLabel(action.action.type)}
            trailing={action.enabled ? "On" : "Off"}
            lines={signalActionLines(action.action)}
          >
            {draft?.actionId === action.id ? (
              form
            ) : (
              <>
                <PillButton
                  label={action.enabled ? "Turn off" : "Turn on"}
                  disabled={props.disabled}
                  onPress={() => props.onSetEnabled(action, !action.enabled)}
                />
                {editable ? (
                  <PillButton label="Change" disabled={props.disabled} onPress={() => props.onDraft(editable)} />
                ) : null}
                <PillButton label="Delete" disabled={props.disabled} onPress={() => props.onDelete(action)} />
              </>
            )}
          </AppDetailRow>
        );
      })}
      {draft && draft.actionId === undefined ? (
        <AppDetailRow first={false} title="New notification" lines={[]}>
          {form}
        </AppDetailRow>
      ) : (
        <SettingsActionRow
          icon="plus"
          label="Add a notification"
          disabled={props.disabled}
          onPress={() => props.onDraft(newNotifyDraft(signal.name))}
        />
      )}
    </SettingsSection>
  );
}

/** The form of one `notify` action: its two templates. The line under the fields says what a template takes. */
function NotifyForm(props: {
  readonly draft: NotifyDraft;
  readonly disabled: boolean;
  readonly onChange: (draft: NotifyDraft | null) => void;
  readonly onSave: () => void;
}) {
  const { draft } = props;
  return (
    <View className="w-full gap-2">
      <TextInput
        accessibilityLabel="Title template"
        autoFocus
        autoCapitalize="sentences"
        placeholder="Title template"
        value={draft.title}
        maxLength={300}
        onChangeText={(title) => props.onChange({ ...draft, title })}
        className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 text-sm text-foreground"
      />
      <TextInput
        accessibilityLabel="Detail template"
        multiline
        autoCapitalize="sentences"
        placeholder="Detail template"
        value={draft.detail}
        maxLength={500}
        onChangeText={(detail) => props.onChange({ ...draft, detail })}
        className="min-h-20 rounded-2xl border border-border bg-input px-3.5 py-3 text-sm text-foreground"
      />
      <SettingsNote>{TEMPLATE_NOTE}</SettingsNote>
      <View className="flex-row gap-2">
        <PillButton label="Save" disabled={props.disabled} onPress={props.onSave} />
        <PillButton label="Cancel" onPress={() => props.onChange(null)} />
      </View>
    </View>
  );
}
