import { useCallback } from "react";

import type { HostApi } from "@solus/client-core/host-api";

import { WebhookListRow } from "../../webhooks/webhook-rows";
import { LoadedSection } from "../app-rows";
import { linkedText } from "../apps";
import { useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/** Sessions (docs/plans/apps.md §9.2): the sessions that made or changed the app. A row opens its thread. */
export function SessionsSection({ hostId, appId, connected, navigation }: AppSectionProps) {
  const readSessions = useCallback((api: HostApi) => api.appSessions({ appId }), [appId]);
  const sessions = useAppRead(hostId, appId, "sessions", readSessions);
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
        items.map((session, index) => (
          <WebhookListRow
            key={session.sessionId}
            first={index === 0}
            title={session.title ?? "Untitled session"}
            lines={[{ text: linkedText(session.linkedAt, now) }]}
            onPress={() => navigation.navigate("Thread", { hostId, sessionId: session.sessionId })}
          />
        ))
      }
    </LoadedSection>
  );
}
