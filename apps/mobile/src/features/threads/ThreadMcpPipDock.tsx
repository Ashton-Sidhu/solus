import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { mcpAppsFor, type McpAppRead } from "@solus/client-core/mcp-app-store";

import { useApp, useListened } from "../../app/app-context";
import type { ConversationStore } from "../conversation/conversation-store";
import { McpAppCard } from "./ThreadMcpApp";

const NO_APP: McpAppRead = { phase: "idle" };

/**
 * The saved app the person or the app put in picture-in-picture, docked above
 * the composer at the full width (docs/plans/mcp-first-class.md §14.2). It is
 * a new frame of the saved app, as full screen is on this client. While the
 * keyboard is open it folds to its title bar.
 */
export function ThreadMcpPipDock({ store, isKeyboardVisible }: { readonly store: ConversationStore; readonly isKeyboardVisible: boolean }) {
  const app = useApp();
  const api = app.connections.connection(store.controller.hostId)?.api;
  const readPip = useCallback(() => store.mcpAppPip, [store]);
  const pip = useListened(store.mcpAppPipChanges, readPip);
  const sessionId = store.controller.run.sessionId;
  const apps = useMemo(() => (api ? mcpAppsFor(api) : null), [api]);
  const request = useMemo(() => (pip ? { sessionId, activityId: pip.activityId } : null), [pip, sessionId]);
  const subscribe = useCallback((listener: () => void) => (apps && request ? apps.subscribe(request, listener) : () => {}), [apps, request]);
  const read = useCallback(() => (apps && request ? apps.read(request) : NO_APP), [apps, request]);
  const saved = useSyncExternalStore(subscribe, read, read);
  const closedKeys = useMemo(() => (request ? [request.activityId] : []), [request]);
  const onClosedChange = useCallback((isClosed: boolean) => {
    if (isClosed) store.setMcpAppPip(null);
  }, [store]);

  useEffect(() => {
    if (apps && request) void apps.load(request);
  }, [apps, request]);

  // A docked app that is no longer available goes back to its card, which shows the error.
  useEffect(() => {
    if (saved.phase === "error") store.setMcpAppPip(null);
  }, [saved.phase, store]);

  if (!api || !pip || !request || saved.phase !== "ready") return null;
  return (
    <McpAppCard
      key={request.activityId}
      store={store}
      api={api}
      request={request}
      title={pip.title}
      document={saved.snapshot}
      closedKeys={closedKeys}
      isClosed={false}
      onClosedChange={onClosedChange}
      docked
      isFolded={isKeyboardVisible}
    />
  );
}
