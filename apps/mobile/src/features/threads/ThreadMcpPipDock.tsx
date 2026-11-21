import { useCallback, useEffect, useMemo } from "react";

import { useListened } from "../../app/app-context";
import { conversationIdOf, type ConversationStore } from "../conversation/conversation-store";
import { useHostApi } from "../projects/use-open-project";
import { McpAppCard } from "./ThreadMcpApp";
import { useSavedMcpApp } from "./use-saved-mcp-app";

/**
 * The saved app the person or the app put in picture-in-picture, docked above
 * the composer at the full width (docs/plans/mcp-first-class.md §14.2). It is
 * a new frame of the saved app, as full screen is on this client. While the
 * keyboard is open it folds to its title bar.
 */
export function ThreadMcpPipDock({ store, isKeyboardVisible }: { readonly store: ConversationStore; readonly isKeyboardVisible: boolean }) {
  const api = useHostApi(store.controller.hostId);
  const readPip = useCallback(() => store.mcpAppPip, [store]);
  const pip = useListened(store.mcpAppPipChanges, readPip);
  const sessionId = conversationIdOf(store);
  const request = useMemo(() => (pip ? { sessionId, activityId: pip.activityId } : null), [pip, sessionId]);
  const { app: saved } = useSavedMcpApp(api, request);
  const closedKeys = useMemo(() => (request ? [request.activityId] : []), [request]);
  const onClosedChange = useCallback((isClosed: boolean) => {
    if (isClosed) store.setMcpAppPip(null);
  }, [store]);

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
