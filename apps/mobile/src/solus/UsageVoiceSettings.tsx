import {
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { HostApi } from "@solus/client-core/host-api";
import { PROVIDERS } from "@solus-mobile/features/conversation/lib/run-settings";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { useSolusSettingsFilter } from "../features/settings/settings-environment-filter";
import { useSettingsEnvironmentMenu } from "../features/settings/components/SettingsEnvironmentFilterHeader";
import { SettingsPage } from "./SettingsPages";
import { Note, useSettingsAction } from "./SettingsFeedback";
import { useHostSettingsRead } from "./use-host-settings-read";
import { useSolusDirectory } from "./runtime";

const readLimits = (api: HostApi) => api.usageLimits();
function HostLimits({
  hostId,
  label,
  provider,
}: {
  hostId: string;
  label: string;
  provider?: string;
}) {
  const state = useHostSettingsRead(hostId, readLimits);
  const nav = useNavigation();
  const rows = state.data?.filter((p) => !provider || p.provider === provider);
  return (
    <SettingsSection title={label}>
      {!rows ? (
        <Note>{state.error ?? "Loading usage limits…"}</Note>
      ) : (
        !rows.length && <Note>No provider reports limits.</Note>
      )}
      {rows?.map((p) => {
        const name =
          PROVIDERS.find((v) => v.id === p.provider)?.label ?? p.provider;
        if (!provider)
          return (
            <SettingsRow
              key={p.provider}
              icon="person.crop.circle"
              label={name}
              value={p.planType ?? p.usageMode}
              onPress={() =>
                nav.navigate("SettingsUsageAccount", {
                  accountKey: p.provider,
                  windowId: "",
                  windowKind: "rolling",
                  environmentIds: [hostId],
                  now: Date.now(),
                })
              }
            />
          );
        return (
          <Note key={p.provider}>
            {[
              name,
              p.stale
                ? "Last known limits"
                : p.usageMode === "signed_out"
                  ? "Signed out"
                  : p.usageMode === "api"
                    ? "Metered API billing"
                    : p.planType,
              ...(
                [
                  ["5 hours", p.fiveHour],
                  ["Weekly", p.weekly],
                  ["Monthly", p.monthly],
                ] as const
              ).flatMap(([label, w]) =>
                w
                  ? [
                      `${label}: ${w.usedPercent}% used` +
                        (w.resetsAt
                          ? " · resets " + new Date(w.resetsAt).toLocaleString()
                          : w.resetsLabel
                            ? " · " + w.resetsLabel
                            : ""),
                    ]
                  : [],
              ),
            ]
              .filter(Boolean)
              .join("\n")}
          </Note>
        );
      })}
      <SettingsRow
        icon="arrow.clockwise"
        label="Refresh limits"
        onPress={state.refresh}
      />
    </SettingsSection>
  );
}
export function UsageSettings({
  workspace = false,
}: { workspace?: boolean } = {}) {
  const menu = useSettingsEnvironmentMenu(),
    { scopedTargets } = useSolusSettingsFilter();
  return (
    <SettingsPage title="Usage" workspaceRoot={workspace} menus={[menu]}>
      {scopedTargets.length === 0 && (
        <Note>Select a connected environment.</Note>
      )}
      {scopedTargets.map((h) => (
        <HostLimits
          key={h.environmentId}
          hostId={h.environmentId}
          label={h.environmentLabel}
        />
      ))}
    </SettingsPage>
  );
}
export function UsageAccountSettings({
  route,
}: StaticScreenProps<{
  accountKey: string;
  environmentIds: readonly string[] | null;
  windowKind: string;
  windowId: string;
  now: number;
}>) {
  const { hostsById } = useSolusDirectory();
  return (
    <SettingsPage title="Account">
      {route.params.environmentIds?.map((id) => (
        <HostLimits
          key={id}
          hostId={id}
          label={hostsById[id]?.environmentLabel ?? id}
          provider={route.params.accountKey}
        />
      ))}
    </SettingsPage>
  );
}
const readModel = (api: HostApi) => api.voiceModelStatus();
export function VoiceModelSettings({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId }>) {
  const state = useHostSettingsRead(
    route.params.environmentId,
    readModel,
    "voice.modelStatusChanged",
  );
  const { run, busy } = useSettingsAction(state.refresh);
  return (
    <SettingsPage title="Transcription model">
      <SettingsSection title="Host model">
        <Note>
          {state.error ??
            state.data?.error ??
            state.data?.state ??
            "Reading model status…"}
        </Note>
        {state.data?.state === "error" && (
          <SettingsRow
            icon="arrow.clockwise"
            label="Retry model installation"
            disabled={busy}
            onPress={() => void run(() => state.api!.voiceModelRetry())}
          />
        )}
        <SettingsRow
          icon="arrow.clockwise"
          label="Refresh"
          onPress={state.refresh}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
