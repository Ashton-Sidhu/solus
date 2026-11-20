import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useIsFocused } from "@react-navigation/native";
import type { HostApi } from "@solus/client-core/host-api";
import { mcpAppLiveCall, mcpAppLiveFor } from "@solus/client-core/mcp-app-live";
import { mcpAppsFor, type McpAppRead } from "@solus/client-core/mcp-app-store";
import { mcpAppLiveToolName, type McpAppCancelReason, type McpAppLiveDocument } from "@solus/contracts/mcp-apps";

import { useListened } from "../../app/app-context";
import type { ConversationStore } from "../conversation/conversation-store";
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import { McpAppCard } from "./ThreadMcpApp";

const NO_APP: McpAppRead = { phase: "idle" };

/**
 * The app of a tool call that has not ended (docs/plans/mcp-first-class.md
 * §14.1). It mounts only for a call that runs when the row mounts, and only
 * when the host says the tool has an app for this person. It follows the
 * call, then takes the call's saved app in the same frame. A call that gives
 * no result removes the card, and the plain tool row stays.
 */
export function ThreadMcpLiveApp(props: { readonly store: ConversationStore; readonly api: HostApi; readonly tool: Extract<TranscriptItem, { kind: "tool" }> }) {
  const { store, api, tool } = props;
  const sessionId = store.controller.run.sessionId;
  const live = useMemo(() => mcpAppLiveFor(api), [api]);
  const apps = useMemo(() => mcpAppsFor(api), [api]);
  // Decided once: a row that mounts after its call ended leaves the app to the saved card.
  const [toolUseId] = useState(() => (tool.status === "running" ? tool.toolId : undefined));
  const toolName = mcpAppLiveToolName(tool.toolName);
  const [liveDocument, setLiveDocument] = useState<McpAppLiveDocument | null>(null);
  const [cancelled, setCancelled] = useState<McpAppCancelReason | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [isClosed, setIsClosed] = useState(() => !!toolUseId && store.closedMcpApps.has(toolUseId));
  const status = useListened(store.meta, store.metaSnapshotOf).status;
  // A hidden screen gives the app no partial input; the newest arrives when it shows again.
  const isFocused = useIsFocused();

  useEffect(() => {
    if (!toolUseId || !toolName) return;
    let isCurrent = true;
    void live.document({ sessionId, toolName }).then((document) => {
      if (isCurrent) setLiveDocument(document);
    });
    return () => {
      isCurrent = false;
    };
  }, [live, sessionId, toolName, toolUseId]);

  // A card that shows an app holds its call, so the saved card of the call hands it its activity.
  useEffect(() => {
    if (!toolUseId || !liveDocument || cancelled) return;
    return live.hold(sessionId, toolUseId, (id) => {
      setActivityId((current) => {
        if (current) return current;
        const height = store.mcpAppHeights.get(toolUseId);
        if (height) store.mcpAppHeights.set(id, height);
        return id;
      });
    });
  }, [live, sessionId, toolUseId, liveDocument, cancelled, store]);

  const request = useMemo(() => ({ sessionId, activityId: activityId ?? "" }), [sessionId, activityId]);
  const savedSubscribe = useCallback((listener: () => void) => (activityId ? apps.subscribe(request, listener) : () => {}), [apps, request, activityId]);
  const readSaved = useCallback(() => (activityId ? apps.read(request) : NO_APP), [apps, request, activityId]);
  const saved = useSyncExternalStore(savedSubscribe, readSaved, readSaved);
  useEffect(() => {
    if (activityId) void apps.load(request);
  }, [apps, request, activityId]);

  const call = useMemo(() => mcpAppLiveCall(tool, status === "interrupted", isFocused), [tool, status, isFocused]);
  if (!toolUseId || !liveDocument || cancelled) return null;
  return (
    <McpAppCard
      store={store}
      api={api}
      request={request}
      title={liveDocument.title}
      document={liveDocument}
      closedKeys={activityId ? [toolUseId, activityId] : [toolUseId]}
      isClosed={isClosed}
      onClosedChange={setIsClosed}
      call={call}
      savedCall={saved.phase === "ready" ? saved.snapshot : undefined}
      onCancelled={setCancelled}
    />
  );
}
