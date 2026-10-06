import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { useApp } from "../../app/app-context";
import { threadProjectFallbackTitle } from "../threads/threadListV2";
import { agentLiveActivityBridge } from "./agent-live-activity-bridge";
import { AgentLiveActivityController } from "./agent-live-activity-controller";

/** Session changes arrive in bursts (a turn starting and settling): one card update each. */
const SYNC_DELAY_MS = 300;
/** Half the stale window: a quiet card keeps its date while the app runs. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * The Live Activity for this device's agent work (iOS). Mount once, in the
 * workspace layout beside the thread-list refresh that keeps its data current.
 */
export function useAgentLiveActivity(): void {
  const app = useApp();
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const controller = new AgentLiveActivityController({
      bridge: agentLiveActivityBridge,
      ready: () => !app.threads.isLoading(),
      read: () => ({
        threads: app.threads.threads(),
        liveStatus: app.threadList.facts().liveStatus,
        projectTitleOf: (thread) => threadProjectFallbackTitle(thread.record),
      }),
      enabled: app.liveActivity.enabled,
      foreground: () => AppState.currentState === "active",
      now: Date.now,
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
    controller.sync();
    return () => {
      for (const stop of stops) stop();
      appState.remove();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
    };
  }, [app]);
}
