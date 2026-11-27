import { mcpAppLiveFor } from "@solus/client-core/mcp-app-live";
import { solus } from "./runtime";
import { conversationIdOf, type ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { createContext, type ReactNode } from "react";
import { Atom } from "effect/reactivity";
import { resolveConversationImage } from "./session-media";
import { remoteAgentChild } from "./agent-child-host";
import { conversationFeed } from "./conversation-feed";

export const SessionCardRenderer = createContext<
  (store: ConversationStore, id: string, appOnly?: boolean) => ReactNode
>(() => null);

// Keep the row translations with the account-scoped store during a warm revisit.
type FeedProjector = ReturnType<typeof conversationFeed>;
const projectors = new WeakMap<ConversationStore, FeedProjector>();
export const sessionFeed = Atom.family((store: ConversationStore) => {
  let project = projectors.get(store);
  if (!project) {
    const translate = conversationFeed(
      store,
      store.controller.run.sessionId,
      (key, appOnly) => (
        <SessionCardRenderer.Consumer>
          {(render) => render(store, key, appOnly)}
        </SessionCardRenderer.Consumer>
      ),
      (path, refresh) => resolveConversationImage(store, path, refresh).then((image) => image.uri),
      (key) => store.controller.readToolInput(key),
      { get provider() { return store.controller.run.provider; }, child: remoteAgentChild(store.controller.hostId) },
      (toolUseId) => {
        const api = solus.connections.connection(store.controller.hostId)?.api;
        return !!api && mcpAppLiveFor(api).isHeld(conversationIdOf(store), toolUseId);
      },
    );
    let lastOrder: readonly string[] | undefined;
    let lastReader: ReturnType<FeedProjector> | undefined;
    project = (order) => {
      if (order !== lastOrder || !lastReader) {
        lastReader = translate(order);
        lastOrder = order;
      }
      return lastReader;
    };
    projectors.set(store, project);
  }
  const read = project;
  return Atom.make((get) => {
    let reader = read(store.orderSnapshot());
    const snapshot = () => ({ feed: reader.get(), projection: reader.projection });
    const update = () => get.setSelf(snapshot());
    let stop = reader.subscribe(update);
    get.addFinalizer(
      store.order.subscribe(() => {
        stop();
        reader = read(store.orderSnapshot());
        stop = reader.subscribe(update);
        update();
      }),
    );
    get.addFinalizer(() => stop());
    return snapshot();
  }).pipe(Atom.setIdleTTL(0));
});
