import { useState, type ReactNode } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";

import type { AppCallView, AppScheduleView, AppSecretState, AppSessionLink, AppVersionView, AppWebhookView } from "@solus/contracts/apps";

import { ErrorBanner } from "../../components/ErrorBanner";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PillButton, WebhookListRow } from "../webhooks/webhook-rows";
import { AppDetailRow, CopyPill } from "./app-rows";
import {
  callAgeText,
  callLines,
  canMakeActive,
  linkedText,
  scheduleLines,
  VERSION_DIFF_NOTE,
  versionLines,
  versionStateLabel,
  webhookLines,
} from "./apps";
import type { Loadable } from "./use-app";

/** One list of the app's sheet: its rows, or why there are none. */
function LoadedSection<T>(props: {
  readonly title: string;
  readonly read: Loadable<readonly T[]>;
  readonly empty: string;
  /** A quiet line under the rows. */
  readonly note?: string;
  readonly onRetry: () => void;
  readonly children: (items: readonly T[]) => ReactNode;
}) {
  const { read } = props;
  if (read.kind === "error") {
    return (
      <View className="gap-3">
        <ErrorBanner message={`${props.title} could not be read: ${read.message}`} />
        <PillButton label="Try again" onPress={props.onRetry} />
      </View>
    );
  }
  return (
    <View className="gap-3">
      <SettingsSection title={props.title}>
        {read.kind === "loading" ? (
          <View className="items-center p-4">
            <ActivityIndicator accessibilityLabel={`Reading ${props.title.toLowerCase()}`} colorClassName="accent-icon-muted" />
          </View>
        ) : read.value.length === 0 ? (
          <View className="px-2 py-4">
            <SettingsNote>{props.empty}</SettingsNote>
          </View>
        ) : (
          props.children(read.value)
        )}
      </SettingsSection>
      {props.note ? <SettingsNote>{props.note}</SettingsNote> : null}
    </View>
  );
}

/** The versions, newest first. An earlier version can run again; the source diff is on desktop and web. */
export function VersionsSection(props: {
  readonly versions: Loadable<AppVersionView[]>;
  readonly disabled: boolean;
  readonly onRetry: () => void;
  readonly onMakeActive: (version: number) => void;
}) {
  const now = Date.now();
  return (
    <LoadedSection title="Versions" read={props.versions} empty="No version yet." note={VERSION_DIFF_NOTE} onRetry={props.onRetry}>
      {(versions) =>
        versions.map((version, index) => (
          <AppDetailRow
            key={version.number}
            first={index === 0}
            title={`v${version.number}`}
            trailing={versionStateLabel(version.state)}
            trailingTone={version.state === "failed" ? "danger" : "muted"}
            lines={versionLines(version, now)}
          >
            {canMakeActive(version) ? (
              <PillButton label="Make active" disabled={props.disabled} onPress={() => props.onMakeActive(version.number)} />
            ) : null}
          </AppDetailRow>
        ))
      }
    </LoadedSection>
  );
}

/** The schedules the active version declares. The owner pauses one, turns it on, or runs it now. */
export function SchedulesSection(props: {
  readonly schedules: Loadable<AppScheduleView[]>;
  readonly disabled: boolean;
  readonly onRetry: () => void;
  readonly onSetEnabled: (name: string, enabled: boolean) => void;
  readonly onRunNow: (name: string) => void;
}) {
  const now = Date.now();
  return (
    <LoadedSection title="Schedules" read={props.schedules} empty="This app declares no schedule." onRetry={props.onRetry}>
      {(schedules) =>
        schedules.map((schedule, index) => (
          <AppDetailRow
            key={schedule.name}
            first={index === 0}
            title={schedule.name}
            trailing={schedule.enabled ? "On" : "Paused"}
            lines={scheduleLines(schedule, now)}
          >
            <PillButton
              label={schedule.enabled ? "Pause" : "Turn on"}
              disabled={props.disabled}
              onPress={() => props.onSetEnabled(schedule.name, !schedule.enabled)}
            />
            <PillButton label="Run now" disabled={props.disabled} onPress={() => props.onRunNow(schedule.name)} />
          </AppDetailRow>
        ))
      }
    </LoadedSection>
  );
}

/**
 * The secrets the app declares. The owner gives a value in a masked field or
 * clears it; a value is never read back, so the row says only whether it is set.
 */
export function SecretsSection(props: {
  readonly secrets: readonly AppSecretState[];
  readonly disabled: boolean;
  readonly onSet: (name: string, value: string) => void;
  readonly onClear: (secret: AppSecretState) => void;
}) {
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null);
  const save = () => {
    if (!editing || editing.value === "") return;
    props.onSet(editing.name, editing.value);
    setEditing(null);
  };
  return (
    <View className="gap-3">
      <SettingsSection title="Secrets">
        {props.secrets.length === 0 ? (
          <View className="px-2 py-4">
            <SettingsNote>This app declares no secret.</SettingsNote>
          </View>
        ) : (
          props.secrets.map((secret, index) => (
            <AppDetailRow
              key={secret.name}
              first={index === 0}
              title={secret.label}
              trailing={secret.isSet ? "Set" : "Not set"}
              trailingTone={secret.isSet ? "muted" : "danger"}
              lines={secret.description ? [{ text: secret.description }] : []}
            >
              {editing?.name === secret.name ? (
                <View className="w-full gap-2">
                  <TextInput
                    accessibilityLabel={`Value of ${secret.label}`}
                    autoFocus
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    placeholder="Paste the value"
                    value={editing.value}
                    onChangeText={(value) => setEditing({ name: secret.name, value })}
                    onSubmitEditing={save}
                    returnKeyType="done"
                    className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 font-mono text-sm text-foreground"
                  />
                  <View className="flex-row gap-2">
                    <PillButton label="Save" disabled={props.disabled || editing.value === ""} onPress={save} />
                    <PillButton label="Cancel" onPress={() => setEditing(null)} />
                  </View>
                </View>
              ) : (
                <>
                  <PillButton
                    label={secret.isSet ? "Replace" : "Set"}
                    disabled={props.disabled}
                    onPress={() => setEditing({ name: secret.name, value: "" })}
                  />
                  {secret.isSet ? <PillButton label="Clear" disabled={props.disabled} onPress={() => props.onClear(secret)} /> : null}
                </>
              )}
            </AppDetailRow>
          ))
        )}
      </SettingsSection>
      {props.secrets.length > 0 ? <SettingsNote>A value stays on the host. No client and no agent reads it back.</SettingsNote> : null}
    </View>
  );
}

/** The webhooks the app declares. The owner copies the URL and the signing secret into the other service. */
export function WebhooksSection(props: { readonly webhooks: Loadable<AppWebhookView[]>; readonly onRetry: () => void }) {
  const hasWebhooks = props.webhooks.kind === "loaded" && props.webhooks.value.length > 0;
  return (
    <LoadedSection
      title="Webhooks"
      read={props.webhooks}
      empty="This app declares no webhook."
      note={hasWebhooks ? "The URL and the signing secret are credentials. Give them only to the service that sends the requests." : undefined}
      onRetry={props.onRetry}
    >
      {(webhooks) =>
        webhooks.map((webhook, index) => (
          <AppDetailRow
            key={webhook.name}
            first={index === 0}
            title={webhook.name}
            trailing={webhook.webhookId === null ? "Not made" : webhook.enabled ? "On" : "Paused"}
            trailingTone={webhook.webhookId === null ? "danger" : "muted"}
            lines={webhookLines(webhook)}
          >
            {webhook.url !== null ? <CopyPill label="Copy URL" target="webhook URL" value={webhook.url} /> : null}
            {webhook.secret !== null ? <CopyPill label="Copy signing secret" target="signing secret" value={webhook.secret} /> : null}
          </AppDetailRow>
        ))
      }
    </LoadedSection>
  );
}

/** The newest calls of the call log. It names the operation and its caller, never the input or the result. */
export function CallsSection(props: {
  readonly calls: Loadable<AppCallView[]>;
  /** The app's webhooks when they are read, to name a webhook caller. */
  readonly webhooks: readonly AppWebhookView[];
  readonly onRetry: () => void;
}) {
  const now = Date.now();
  return (
    <LoadedSection title="Calls" read={props.calls} empty="No calls yet." onRetry={props.onRetry}>
      {(calls) =>
        calls.map((call, index) => (
          <AppDetailRow
            key={call.id}
            first={index === 0}
            title={call.operation}
            trailing={callAgeText(call, now)}
            lines={callLines(call, props.webhooks)}
          />
        ))
      }
    </LoadedSection>
  );
}

/** The sessions that made or changed the app. A row opens its thread. */
export function SessionsSection(props: {
  readonly sessions: Loadable<AppSessionLink[]>;
  readonly onRetry: () => void;
  readonly onOpen: (sessionId: string) => void;
}) {
  const now = Date.now();
  return (
    <LoadedSection title="Sessions" read={props.sessions} empty="No session is linked to this app." onRetry={props.onRetry}>
      {(sessions) =>
        sessions.map((session, index) => (
          <WebhookListRow
            key={session.sessionId}
            first={index === 0}
            title={session.title ?? "Untitled session"}
            lines={[{ text: linkedText(session.linkedAt, now) }]}
            onPress={() => props.onOpen(session.sessionId)}
          />
        ))
      }
    </LoadedSection>
  );
}
