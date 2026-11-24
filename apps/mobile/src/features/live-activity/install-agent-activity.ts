import type { SolusApp } from "@solus-mobile/app/solus-app";
import { threadProjectFallbackTitle } from "@solus-mobile/features/threads/threadListV2";
import { AppState, Platform } from "react-native";

import { agentLiveActivityBridge } from "./agent-live-activity-bridge";
import { AgentLiveActivityController } from "./agent-live-activity-controller";

const SYNC_DELAY_MS = 300;
const HOST_WAIT_MS = 10_000;
const REFRESH_INTERVAL_MS = 5 * 60_000;

export function installAgentActivity(app: SolusApp): () => void {
  const storage = app.platform.storage;
  let startedAt = Date.now();
  const createController = (scope: string) =>
    new AgentLiveActivityController({
      bridge: agentLiveActivityBridge,
      ready: () =>
        (app.registry.listState() === "ready" && !app.threads.isLoading()) ||
        Date.now() - startedAt >= HOST_WAIT_MS,
      read: () => {
        const { liveStatus, awaitingApprovals } = app.threadList.facts();
        return {
          threads: app.threads.threads(),
          liveStatus,
          awaitingApprovals,
          projectTitleOf: (thread) => threadProjectFallbackTitle(thread.record),
        };
      },
      enabled: app.liveActivity.enabled,
      foreground: () => AppState.currentState === "active",
      now: Date.now,
      storage,
      scope,
      relay: {
        register(pushToken, generation, card) {
          for (const { api, hostId } of app.connections.readyConnections()) {
            if (!app.registry.host(hostId)) continue;
            void api
              .liveActivityRegister({
                pushToken,
                environment: __DEV__ ? "sandbox" : "production",
                generation,
                card,
                hostId,
              })
              .catch(() => {});
          }
        },
        unregister(pushToken) {
          for (const { api, hostId } of app.connections.readyConnections()) {
            if (app.registry.host(hostId))
              void api.liveActivityUnregister(pushToken).catch(() => {});
          }
        },
      },
    });

  let scope = app.sessionCache.scope();
  let controller = createController(scope);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refresh = false;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (refresh) {
        refresh = false;
        controller.refresh();
      } else controller.sync();
    }, SYNC_DELAY_MS);
  };
  const refreshSoon = () => {
    refresh = true;
    schedule();
  };
  let { liveStatus, awaitingApprovals } = app.threadList.facts();
  const onFacts = () => {
    const facts = app.threadList.facts();
    if (
      liveStatus === facts.liveStatus &&
      awaitingApprovals === facts.awaitingApprovals
    )
      return;
    ({ liveStatus, awaitingApprovals } = facts);
    schedule();
  };
  let hostWait = setTimeout(schedule, HOST_WAIT_MS);
  const stops = [
    app.account.changes.subscribe(() => {
      const next = app.sessionCache.scope();
      if (next === scope) return;
      controller.clear();
      controller.dispose();
      scope = next;
      startedAt = Date.now();
      controller = createController(scope);
      clearTimeout(hostWait);
      hostWait = setTimeout(schedule, HOST_WAIT_MS);
      schedule();
    }),
    app.threads.changes.subscribe(schedule),
    app.threadList.changes.subscribe(onFacts),
    app.liveActivity.changes.subscribe(() => controller.sync()),
  ];
  if (Platform.OS === "ios") {
    // A host that reconnected needs the current card, even if the rows match.
    let readyHosts = new Map<string, number>();
    stops.push(
      app.connections.changes.subscribe(() => {
        const next = new Map(
          app.connections
            .readyConnections()
            .filter(({ hostId }) => app.registry.host(hostId))
            .map(({ hostId, state }) => [hostId, state.sessionGeneration]),
        );
        const reconnected = [...next].some(
          ([hostId, generation]) => readyHosts.get(hostId) !== generation,
        );
        readyHosts = next;
        if (reconnected) refreshSoon();
      }),
    );
  }
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") refreshSoon();
  });
  const heartbeat = setInterval(() => {
    if (
      AppState.currentState === "active" &&
      app.connections.readyConnections().length > 0
    )
      refreshSoon();
  }, REFRESH_INTERVAL_MS);
  schedule();
  return () => {
    controller.dispose();
    stops.forEach((stop) => stop());
    appState.remove();
    clearInterval(heartbeat);
    clearTimeout(hostWait);
    clearTimeout(timer);
  };
}
