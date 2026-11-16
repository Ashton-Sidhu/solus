import { useCallback, useEffect, useState } from "react";

import type { HostApi } from "@solus/client-core/host-api";
import { sessionRecordStatusOf, type SessionRecordStatus } from "@solus/contracts/types";

import { useApp } from "../../../app/app-context";
import { AppListRow, LoadedSection } from "../app-rows";
import { sessionState } from "../app-states";
import { sessionLine } from "../apps";
import { useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Sessions (docs/plans/apps.md §9.2): the sessions that made or changed the
 * app, each with the mark of how its run stands. A row opens its thread.
 */
export function SessionsSection({ hostId, appId, connected, navigation }: AppSectionProps) {
  const readSessions = useCallback((api: HostApi) => api.appSessions({ appId }), [appId]);
  const sessions = useAppRead(hostId, appId, "sessions", readSessions);
  const heard = useHeardStatuses(hostId, connected);
  const now = Date.now();

  return (
    <LoadedSection
      title="Sessions"
      read={sessions.state}
      connected={connected}
      subject="The linked sessions"
      empty="No session is linked to this app."
      onRetry={sessions.reload}
    >
      {(items) =>
        items.map((session, index) => {
          const status = heard[session.sessionId] ?? session.status;
          return (
            <AppListRow
              key={session.sessionId}
              first={index === 0}
              mark={{ state: sessionState(status) }}
              title={session.title ?? "Untitled session"}
              lines={[{ text: sessionLine(status, session.linkedAt, now) }]}
              onPress={() => navigation.navigate("Thread", { hostId, sessionId: session.sessionId })}
            />
          );
        })
      }
    </LoadedSection>
  );
}

/**
 * The status each session's run took while the screen is open. The host
 * writes a session's record after it sends the event, so a read at that
 * moment can still give the old status; the event wins.
 */
function useHeardStatuses(hostId: string, connected: boolean): { readonly [sessionId: string]: SessionRecordStatus } {
  const app = useApp();
  const [heard, setHeard] = useState<{ readonly [sessionId: string]: SessionRecordStatus }>({});
  useEffect(() => {
    const current = connected ? app.connections.connection(hostId) : null;
    if (!current) return;
    return current.events.subscribe("session.statusChanged", ({ sessionId, status }) => {
      setHeard((previous) => ({ ...previous, [sessionId]: sessionRecordStatusOf(status) }));
    });
  }, [app, hostId, connected]);
  return heard;
}
