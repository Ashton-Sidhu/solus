import { useCallback, useState } from "react";
import { Alert, View } from "react-native";

import {
  activationConfirmation,
  activationLabel,
  canActivate,
  changeLog,
  deployEventTitle,
  deployHistory,
  liveState,
  shortCommit,
  type AppChangeLogEntry,
  type AppDeployEvent,
  type AppLiveState,
} from "@solus/client-core/app-versions";
import type { HostApi } from "@solus/client-core/host-api";

import { SegmentedControl } from "../../../components/SegmentedControl";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppDetailRow, ReadBody } from "../app-rows";
import { changeLogState, deployEventState } from "../app-states";
import { changeLogLines, deployEventLines, liveLines } from "../app-version-lines";
import { agoText, SOURCE_CHANGE_NOTE } from "../apps";
import { useAppChange, useAppDeploy, useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

type VersionsView = "changes" | "deploys";

/**
 * Versions (docs/plans/apps.md §9.2), as the desktop and the web show it: what
 * runs now, the change log of the source in three groups (the saves that do
 * not run, the one that runs, the earlier ones), and the deploys with each
 * rollback and roll forward. A mark at the start of a row says how the save
 * or the deploy stands. The owner deploys a save,
 * rolls back or forward to a build that ran, and opens a build log. A deploy
 * answers only when the build ended: the screen stays free.
 */
export function VersionsSection({ hostId, appId, state, connected, reloadState, navigation }: AppSectionProps) {
  const readRevisions = useCallback((api: HostApi) => api.appRevisions({ appId }), [appId]);
  const readVersions = useCallback((api: HostApi) => api.appVersions({ appId }), [appId]);
  const revisions = useAppRead(hostId, appId, "revisions", readRevisions);
  const versions = useAppRead(hostId, appId, "versions", readVersions);
  const { busy, change } = useAppChange(hostId);
  const { deploying, deploy } = useAppDeploy(hostId, appId);
  const [view, setView] = useState<VersionsView>("changes");
  const reloadVersions = versions.reload;
  const reloadRevisions = revisions.reload;
  const now = Date.now();

  const reloadAll = () => {
    reloadState();
    reloadVersions();
    reloadRevisions();
  };

  const confirmDeploy = (commit: string) => {
    Alert.alert(
      `Deploy revision ${shortCommit(commit)}?`,
      "The host builds this revision. When the build succeeds, the new version is active, and its new migrations change the app's data.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Deploy",
          onPress: () => {
            deploy(commit).then(
              (receipt) => {
                reloadAll();
                if (!receipt.active) Alert.alert(`Version ${receipt.version} is not active`, receipt.error ?? "The build or the start failed. The version before it still runs.");
              },
              (cause: unknown) => Alert.alert("Not deployed", errorMessage(cause)),
            );
          },
        },
      ],
    );
  };

  const confirmActivate = (target: number, live: number | null) => {
    const { title, message } = activationConfirmation(target, live);
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: activationLabel(target, live),
        onPress: () => {
          change("activate", (api) => api.appActivate({ appId, version: target })).then(reloadAll, (cause: unknown) =>
            Alert.alert("Not made active", errorMessage(cause)),
          );
        },
      },
    ]);
  };

  const openBuildLog = (version: number) => navigation.navigate("AppBuildLog", { hostId, appId, version });

  return (
    <ReadBody read={revisions.state} connected={connected} subject="The revisions" onRetry={revisions.reload}>
      {(savedRevisions) => (
        <ReadBody read={versions.state} connected={connected} subject="The versions" onRetry={versions.reload}>
          {(builtVersions) => {
            const live = liveState(savedRevisions, builtVersions);
            const entries = changeLog(savedRevisions, builtVersions);
            const events = deployHistory(builtVersions);
            const liveNumber = live.live?.number ?? null;
            const isBusy = busy !== null || !connected || deploying !== null || live.building !== null;
            const newest = entries[0];
            return (
              <View className="gap-6">
                <LiveSection
                  live={live}
                  newest={newest ?? null}
                  isStopped={state.app.stopped}
                  isBusy={isBusy}
                  deploying={deploying}
                  now={now}
                  onBuildLog={openBuildLog}
                  onActivate={(target) => confirmActivate(target, liveNumber)}
                  onDeploy={confirmDeploy}
                />

                <SegmentedControl
                  role="tab"
                  options={[
                    { value: "changes", label: `Change log ${entries.length}` },
                    { value: "deploys", label: `Deploys ${events.length}` },
                  ]}
                  selected={view}
                  onSelect={setView}
                />

                {view === "changes" ? (
                  entries.length === 0 ? (
                    <SettingsNote>No save yet.</SettingsNote>
                  ) : (
                    CHANGE_LOG_GROUPS.map((group) => {
                      const saves = entries.filter((entry) => entry.position === group.position);
                      return saves.length === 0 ? null : (
                        <SettingsSection key={group.position} title={group.title}>
                          {saves.map((entry, index) => (
                            <ChangeLogItem
                              key={entry.revision.commit}
                              entry={entry}
                              first={index === 0}
                              liveNumber={liveNumber}
                              now={now}
                              isBusy={isBusy}
                              deploying={deploying}
                              onDeploy={confirmDeploy}
                              onActivate={(target) => confirmActivate(target, liveNumber)}
                            />
                          ))}
                        </SettingsSection>
                      );
                    })
                  )
                ) : events.length === 0 ? (
                  <SettingsNote>No deploy yet. Deploy a save from the change log.</SettingsNote>
                ) : (
                  <SettingsSection>
                    {events.map((event, index) => (
                      <DeployEventItem
                        key={`${event.kind}:${event.version.number}:${event.at}`}
                        event={event}
                        first={index === 0}
                        liveNumber={liveNumber}
                        now={now}
                        isBusy={isBusy}
                        onActivate={(target) => confirmActivate(target, liveNumber)}
                        onBuildLog={openBuildLog}
                      />
                    ))}
                  </SettingsSection>
                )}
                <SettingsNote>{SOURCE_CHANGE_NOTE}</SettingsNote>
              </View>
            );
          }}
        </ReadBody>
      )}
    </ReadBody>
  );
}

/** What runs now, and what stands between it and the newest save: a build in progress, a rollback, and the saves that do not run. */
function LiveSection(props: {
  readonly live: AppLiveState;
  readonly newest: AppChangeLogEntry | null;
  readonly isStopped: boolean;
  readonly isBusy: boolean;
  readonly deploying: string | null;
  readonly now: number;
  readonly onBuildLog: (version: number) => void;
  readonly onActivate: (target: number) => void;
  readonly onDeploy: (commit: string) => void;
}) {
  const { live: version, building, rolledBackFrom, ahead } = props.live;
  const newest = props.newest;
  return (
    <SettingsSection title="Running now">
      {version ? (
        <AppDetailRow
          first
          mark={props.isStopped ? { state: "stopped" } : { state: "ok", label: "Live" }}
          title={`v${version.number} · ${version.message || "No message"}`}
          titleLines={2}
          lines={props.isStopped ? [{ text: "The app is stopped." }, ...liveLines(version, props.now)] : liveLines(version, props.now)}
        >
          <PillButton label="Build log" onPress={() => props.onBuildLog(version.number)} />
        </AppDetailRow>
      ) : (
        <AppDetailRow
          first
          mark={{ state: "idle" }}
          title="Nothing runs"
          lines={[{ text: "No version of this app is active yet. Deploy a save: the host builds it, and the version becomes active when it starts." }]}
        />
      )}
      {building ? (
        <AppDetailRow
          first={false}
          mark={{ state: "running" }}
          title={`Building v${building.number}`}
          lines={[{ text: `From revision ${shortCommit(building.revision)}. You can leave this screen: the build continues.` }]}
        >
          <PillButton label="Build log" onPress={() => props.onBuildLog(building.number)} />
        </AppDetailRow>
      ) : null}
      {version && rolledBackFrom ? (
        <AppDetailRow
          first={false}
          mark={{ state: "warning" }}
          title={`Rolled back from v${rolledBackFrom.number}`}
          lines={[{ text: "The newer build is kept and can run again." }]}
        >
          <PillButton label={activationLabel(rolledBackFrom.number, version.number)} disabled={props.isBusy} onPress={() => props.onActivate(rolledBackFrom.number)} />
        </AppDetailRow>
      ) : null}
      {ahead.length > 0 && newest ? (
        <AppDetailRow
          first={false}
          mark={{ state: "idle" }}
          title={ahead.length === 1 ? "1 save does not run" : `${ahead.length} saves do not run`}
          lines={[{ text: `The newest, ${agoText(newest.revision.savedAt, props.now)}: ${newest.revision.message || "No message"}` }]}
        >
          {newest.position === "ahead" && newest.canDeploy ? (
            <PillButton
              label={props.deploying === newest.revision.commit ? "Deploying" : "Deploy the newest"}
              disabled={props.isBusy}
              onPress={() => props.onDeploy(newest.revision.commit)}
            />
          ) : null}
        </AppDetailRow>
      ) : null}
    </SettingsSection>
  );
}

/** The groups of the change log, in the order of the log: the newest saves first. */
const CHANGE_LOG_GROUPS = [
  { position: "ahead", title: "Not running" },
  { position: "live", title: "Running now" },
  { position: "behind", title: "Earlier" },
] as const satisfies readonly { position: AppChangeLogEntry["position"]; title: string }[];

function ChangeLogItem(props: {
  readonly entry: AppChangeLogEntry;
  readonly first: boolean;
  readonly liveNumber: number | null;
  readonly now: number;
  readonly isBusy: boolean;
  readonly deploying: string | null;
  readonly onDeploy: (commit: string) => void;
  readonly onActivate: (target: number) => void;
}) {
  const { entry } = props;
  return (
    <AppDetailRow
      first={props.first}
      mark={{ state: changeLogState(entry) }}
      title={entry.revision.message || "No message"}
      titleLines={2}
      lines={changeLogLines(entry, props.now)}
    >
      {entry.canDeploy ? (
        <PillButton
          label={props.deploying === entry.revision.commit ? "Deploying" : entry.versions.length > 0 ? "Deploy again" : "Deploy"}
          disabled={props.isBusy}
          onPress={() => props.onDeploy(entry.revision.commit)}
        />
      ) : entry.restorable && entry.position !== "live" ? (
        <PillButton label={activationLabel(entry.restorable.number, props.liveNumber)} disabled={props.isBusy} onPress={() => props.onActivate(entry.restorable!.number)} />
      ) : null}
    </AppDetailRow>
  );
}

function DeployEventItem(props: {
  readonly event: AppDeployEvent;
  readonly first: boolean;
  readonly liveNumber: number | null;
  readonly now: number;
  readonly isBusy: boolean;
  readonly onActivate: (target: number) => void;
  readonly onBuildLog: (version: number) => void;
}) {
  const { event } = props;
  return (
    <AppDetailRow first={props.first} mark={{ state: deployEventState(event) }} title={deployEventTitle(event)} lines={deployEventLines(event, props.now)}>
      {event.kind === "deploy" && canActivate(event.version) ? (
        <PillButton label={activationLabel(event.version.number, props.liveNumber)} disabled={props.isBusy} onPress={() => props.onActivate(event.version.number)} />
      ) : null}
      {event.kind === "deploy" || event.kind === "failed" || event.kind === "building" ? (
        <PillButton label="Build log" onPress={() => props.onBuildLog(event.version.number)} />
      ) : null}
    </AppDetailRow>
  );
}
