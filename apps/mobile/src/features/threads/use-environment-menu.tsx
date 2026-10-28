import { isSessionBusyStatus, type SessionStatus, type WorkListingMeta } from "@solus/contracts/types";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useApp, useListened } from "../../app/app-context";
import type { ConversationStore } from "../conversation/conversation-store";
import {
  chooseEnvironmentView,
  chosenEnvironmentView,
  delegatedArtifacts,
  environmentViewMenu,
  phoneEnvironmentFacts,
  transcriptArtifacts,
} from "./environment-view-menu";
import { ThreadArtifactFullScreen, WorkArtifactFullScreen } from "./ThreadArtifact";

type OpenArtifact = { sessionId: string; row: string } | { sessionId: string; workId: string; title: string };

/**
 * The thread header's environment menu and the artifact it opens. It reads the
 * artifacts the loaded transcript shows, and those of the sessions this one
 * sent work to. It waits for both, so it never names Browser and then
 * Artifacts.
 */
export function useEnvironmentMenu(input: {
  readonly store: ConversationStore;
  readonly hostId: string;
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly transcriptLoaded: boolean;
}) {
  const { store, hostId, sessionId } = input;
  const latestArtifactId = useListened(store.order, () => transcriptArtifacts(store.orderSnapshot(), (id) => store.item(id)).latestId);
  const artifactCount = useListened(store.order, () => transcriptArtifacts(store.orderSnapshot(), (id) => store.item(id)).count);
  const delegated = useDelegatedArtifacts(hostId, sessionId, input.status);
  // Read per render, so a route reused for another session never shows this one's choice.
  const [, setChoiceVersion] = useState(0);
  const [openArtifact, setOpenArtifact] = useState<OpenArtifact | null>(null);
  const shown = openArtifact?.sessionId === sessionId ? openArtifact : null;
  const menu = environmentViewMenu(
    phoneEnvironmentFacts({
      chosen: chosenEnvironmentView(hostId, sessionId),
      artifactCount: artifactCount + delegated.works.length,
      artifactsKnown: input.transcriptLoaded && delegated.known,
    }),
    (view) => {
      chooseEnvironmentView(hostId, sessionId, view);
      setChoiceVersion((version) => version + 1);
      if (view !== "artifacts") return;
      // The session's own newest artifact first, else the newest one a worker made.
      const work = delegated.works[0];
      if (latestArtifactId) setOpenArtifact({ sessionId, row: latestArtifactId });
      else if (work) setOpenArtifact({ sessionId, workId: work.id, title: work.title || "Artifact" });
    },
  );
  const close = () => setOpenArtifact(null);
  const artifactScreen: ReactNode = !shown ? null : "row" in shown ? (
    <ThreadArtifactFullScreen store={store} id={shown.row} onClose={close} />
  ) : (
    <WorkArtifactFullScreen hostId={hostId} workId={shown.workId} title={shown.title} onClose={close} />
  );
  return { menu, artifactScreen };
}

/**
 * The artifacts of the sessions this one sent work to, the last changed first.
 * Read when the thread opens and again each time a turn ends, because a
 * worker's report arrives in a turn. A host that fails keeps the last answer;
 * `known` is false until the host answered once for this session.
 */
function useDelegatedArtifacts(hostId: string, sessionId: string, status: SessionStatus): { works: readonly WorkListingMeta[]; known: boolean } {
  const app = useApp();
  const key = `${hostId}\u0000${sessionId}`;
  const [read, setRead] = useState<{ key: string; works: readonly WorkListingMeta[] } | null>(null);
  const readKey = useRef<string | null>(null);
  const busy = isSessionBusyStatus(status);
  useEffect(() => {
    if (busy && readKey.current === key) return;
    readKey.current = key;
    const connection = app.connections.connection(hostId);
    // A turn starting does not drop a read in flight; another session's answer is dropped.
    const land = (works: readonly WorkListingMeta[] | null) => {
      if (readKey.current === key) setRead((previous) => ({ key, works: works ?? (previous?.key === key ? previous.works : []) }));
    };
    if (!connection) land(null);
    else void delegatedArtifacts(connection.api, sessionId).then(land, () => land(null));
  }, [app, hostId, sessionId, key, busy]);
  return read?.key === key ? { works: read.works, known: true } : { works: [], known: false };
}
