import { useCallback } from "react";

import { shortCommit } from "@solus/client-core/app-versions";
import type { HostApi } from "@solus/client-core/host-api";
import type { AppState } from "@solus/contracts/apps";

import { CopyTextButton } from "../../../components/CopyTextButton";
import { ListRow } from "../../../components/ListRow";
import { ListRowLayout } from "../../../components/ListRowLayout";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { PillButton } from "../../webhooks/webhook-rows";
import { madeByText, revisionNote, sessionsLine } from "../app-overview";
import { useAppRead } from "../use-app";

/**
 * Where the app came from and where its source is (docs/plans/apps.md §4.2):
 * who made it, the project folder of its first save, the sessions that worked
 * on it, its slug, its git repository on the host, and its newest revision.
 * The Source, Sessions, and Versions sections hold the rest. The app's state
 * is read before the Overview shows, so the repository path is always here.
 */
export function OverviewSource(props: {
  readonly hostId: string;
  readonly appId: string;
  readonly state: AppState;
  readonly connected: boolean;
  readonly onOpenSessions: () => void;
  readonly onOpenSource: () => void;
}) {
  const { app, repositoryPath } = props.state;
  const readSessions = useCallback((api: HostApi) => api.appSessions({ appId: props.appId }), [props.appId]);
  const sessions = useAppRead(props.hostId, props.appId, "sessions", readSessions);

  return (
    <SettingsSection title="Source" trailing={<PillButton label="Open Source" onPress={props.onOpenSource} />}>
      <ListRowLayout label="Made by" detail={madeByText(app)} />
      {app.project ? (
        <ListRowLayout
          label="Project folder"
          description="Where the app was first saved from."
          detail={app.project}
          accessory={<CopyTextButton accessibilityLabel="Copy the folder" text={app.project} />}
        />
      ) : null}
      <ListRow label="Sessions" description={sessionsLine(sessions.state, props.connected)} onPress={props.onOpenSessions} />
      <ListRowLayout
        label="Slug"
        description="What agents and links call the app."
        detail={app.slug}
        accessory={<CopyTextButton accessibilityLabel="Copy the slug" text={app.slug} />}
      />
      <ListRowLayout
        label="Repository"
        description="A git repository on the host. Only the host writes to it."
        detail={repositoryPath}
        accessory={<CopyTextButton accessibilityLabel="Copy the repository path" text={repositoryPath} />}
      />
      <ListRowLayout
        label="Newest revision"
        description={revisionNote(app)}
        detail={app.latestRevision === null ? undefined : shortCommit(app.latestRevision)}
        accessory={app.latestRevision === null ? undefined : <CopyTextButton accessibilityLabel="Copy the revision" text={app.latestRevision} />}
      />
    </SettingsSection>
  );
}
