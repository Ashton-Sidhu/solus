import type { AttentionEntry } from "@solus/contracts/attention-types";
import { personalSettingsWithDefaults } from "@solus/contracts/settings";
import { threadKey } from "@solus-mobile/features/threads/thread-directory";
import { Listeners } from "@solus-mobile/lib/listeners";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { schedule, isOnScreen, appState } = vi.hoisted(() => ({
  schedule: vi.fn(async () => "notification"),
  isOnScreen: vi.fn(() => false),
  appState: { currentState: "active" },
}));

vi.mock("expo-notifications", () => ({ scheduleNotificationAsync: schedule }));
vi.mock("react-native", () => ({
  AppState: appState,
  Platform: { OS: "ios" },
}));
vi.mock("./notificationNavigation", () => ({
  isAgentThreadOnScreen: isOnScreen,
}));
vi.mock("./notificationPermissions", () => ({
  setupAgentAlertChannels: async () => {},
}));

import { installSolusAgentAlerts } from "./solusAgentAlerts";

const now = Date.parse("2026-11-24T00:00:00Z");

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const changes = new Listeners();
  const preferences = personalSettingsWithDefaults({});
  const current = { scope: "first account" };
  let attention = new Map<string, AttentionEntry>();
  const stop = installSolusAgentAlerts({
    sessionCache: { scope: () => current.scope },
    threadList: {
      changes,
      facts: () => ({
        attention,
        states: new Map(),
        views: new Map(),
        liveStatus: new Map(),
        pullRequests: new Map(),
      }),
    },
    threads: { thread: () => null },
    personal: { current: () => preferences },
  });
  return {
    preferences: preferences.notifications,
    current,
    stop,
    report(...entries: AttentionEntry[]) {
      attention = new Map(
        entries.map((entry) => [
          threadKey("some host", entry.sessionId),
          entry,
        ]),
      );
      changes.notify();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  schedule.mockClear();
  isOnScreen.mockReset().mockReturnValue(false);
  appState.currentState = "active";
});

describe("Solus agent alerts", () => {
  it("alerts once for new work and ignores replayed history", () => {
    const host = fixture();
    try {
      const old: AttentionEntry = {
        sessionId: "finished",
        since: now - 1,
        kind: "finished",
        summary: "Saved",
      };
      const current: AttentionEntry = {
        sessionId: "a/b",
        since: now + 1,
        kind: "question",
        summary: "Private question",
      };
      appState.currentState = "background";
      host.report(old, current);
      host.report(old);
      host.report(old, current);

      expect(schedule).toHaveBeenCalledOnce();
      expect(schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          content: {
            title: "Needs input",
            body: undefined,
            sound: true,
            data: {
              deepLink: "/threads/some%20host/a%2Fb",
              silent: false,
              ephemeral: false,
            },
          },
        }),
      );
    } finally {
      host.stop();
    }
  });

  it("uses foreground and event preferences and skips the session already on screen", () => {
    const host = fixture();
    try {
      host.preferences.channels.toast = true;
      host.preferences.events.session_failed = false;
      isOnScreen.mockReturnValueOnce(true);
      host.report(
        {
          sessionId: "open",
          since: now + 1,
          kind: "question",
          summary: "Open",
        },
        {
          sessionId: "failure",
          since: now + 2,
          kind: "failed",
          summary: "Failure",
        },
        {
          sessionId: "other",
          since: now + 3,
          kind: "needs_approval",
          summary: "Approval",
        },
      );

      expect(schedule).toHaveBeenCalledOnce();
      expect(schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          content: {
            title: "Needs approval",
            body: undefined,
            sound: false,
            data: {
              deepLink: "/threads/some%20host/other",
              silent: true,
              ephemeral: true,
            },
          },
        }),
      );
    } finally {
      host.stop();
    }
  });
});
