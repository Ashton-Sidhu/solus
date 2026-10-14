import type { HostApi } from "@solus/client-core/host-api";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { useApp } from "../../app/app-context";
import { threadProjectFallbackTitle } from "../threads/threadListV2";
import { agentLiveActivityBridge } from "./agent-live-activity-bridge";
import { AgentLiveActivityController, type LiveActivityRelay } from "./agent-live-activity-controller";

/** Session changes arrive in bursts (a turn starting and settling): one card update each. */
const SYNC_DELAY_MS = 300;
/** Half the stale window: a quiet card keeps its date while the app runs. */
const REFRESH_INTERVAL_MS = 5 * 60_000;
/**
 * How long the card waits for every host's first session read. A host that
 * cannot be reached never answers (its read waits for the socket), so past
 * this the card follows the hosts that did answer instead of freezing until
 * iOS marks it out of date.
 */
const HOST_WAIT_MS = 10_000;

/**
 * The Live Activity for this device's agent work (iOS). Mount once, in the
 * workspace layout beside the thread-list refresh that keeps its data current.
 */
export function useAgentLiveActivity(): void {
  const app = useApp();
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    // Every host hears of the card: each reports its own rows while the app is
    // suspended. A host that is not connected now keeps its last registration,
    // which the relay orders by generation.
    const eachHost = (call: (api: HostApi, hostId: string) => Promise<void>) => {
      for (const host of app.registry.hosts()) {
        const connection = app.connections.connection(host.id);
        if (connection) call(connection.api, host.id).catch(() => undefined);
      }
    };
    const relay: LiveActivityRelay = {
      register: (pushToken, generation, card) =>
        eachHost((api, hostId) =>
          api.liveActivityRegister({ pushToken, environment: __DEV__ ? "sandbox" : "production", generation, card, hostId }),
        ),
      unregister: (pushToken) => eachHost((api) => api.liveActivityUnregister(pushToken)),
    };
    const startedAt = Date.now();
    const controller = new AgentLiveActivityController({
      bridge: agentLiveActivityBridge,
      ready: () => !app.threads.isLoading() || Date.now() - startedAt >= HOST_WAIT_MS,
      read: () => ({
        threads: app.threads.threads(),
        liveStatus: app.threadList.facts().liveStatus,
        projectTitleOf: (thread) => threadProjectFallbackTitle(thread.record),
      }),
      enabled: app.liveActivity.enabled,
      foreground: () => AppState.currentState === "active",
      now: Date.now,
      storage: app.platform.storage,
      relay,
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        controller.sync();
      }, SYNC_DELAY_MS);
    };
    const stops = [
      app.threads.changes.subscribe(schedule),
      app.threadList.changes.subscribe(schedule),
      app.liveActivity.changes.subscribe(schedule),
    ];
    // Back in front: read again, and start a card for work begun meanwhile.
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") controller.refresh();
    });
    const heartbeat = setInterval(() => {
      if (AppState.currentState === "active") controller.refresh();
    }, REFRESH_INTERVAL_MS);
    const hostWait = setTimeout(schedule, HOST_WAIT_MS);
    controller.sync();
    return () => {
      for (const stop of stops) stop();
      appState.remove();
      clearInterval(heartbeat);
      clearTimeout(hostWait);
      if (timer) clearTimeout(timer);
    };
  }, [app]);
}
