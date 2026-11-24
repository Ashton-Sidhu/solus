import {
  AGENT_ACTIVITY_IDLE_AFTER_MS,
  type AgentActivityCard,
} from "@solus/contracts/uplink";

import {
  endLocalAndroidActivity,
  hasLocalAndroidActivity,
  updateLocalAndroidActivity,
} from "../agent-awareness/androidNotifications";
import type {
  LiveActivityBridge,
  LiveActivityHandle,
} from "./agent-live-activity-controller";

function publish(card: AgentActivityCard, staleDate: Date): boolean {
  const attention = card.activities.filter(
    (row) =>
      row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
  const hero =
    attention[0] ??
    card.activities.find((row) => row.phase === "failed") ??
    card.activities[0];
  const active = card.activeCount > 0;
  const updatedAt = Date.parse(card.updatedAt);
  const rows = hero
    ? [hero, ...card.activities.filter((row) => row !== hero)]
    : [];
  const lines = rows.map((row) =>
    [row.status, row.threadTitle, row.projectTitle].join("\t"),
  );
  return updateLocalAndroidActivity({
    active: String(active),
    updated_at: String(updatedAt),
    activity_chip: attention.length
      ? "Review"
      : active
        ? "Active"
        : (hero?.status ?? "Done"),
    activity_title: attention.length
      ? `${attention.length} ${attention.length === 1 ? "needs" : "need"} attention`
      : card.subtitle,
    activity_phase: hero?.phase ?? "",
    activity_active_count: String(card.activeCount),
    activity_attention_count: String(attention.length),
    activity_body: hero
      ? `${hero.status}: ${hero.threadTitle} · ${hero.projectTitle}`
      : "",
    activity_path: hero?.deepLink ?? "/",
    activity_expires_at: String(
      active ? staleDate.getTime() : updatedAt + AGENT_ACTIVITY_IDLE_AFTER_MS,
    ),
    activity_line_0: lines[0] ?? "",
    activity_line_1: lines[1] ?? "",
    activity_line_2: lines[2] ?? "",
    activity_line_3: lines[3] ?? "",
    activity_line_4: lines[4] ?? "",
  });
}

const handle: LiveActivityHandle = {
  getId: () => "android-activity",
  update: async (card, staleDate) => {
    publish(card, staleDate);
  },
  end: async () => {
    endLocalAndroidActivity();
  },
  onPushToken: () => () => {},
};

export const agentLiveActivityBridge: LiveActivityBridge = {
  instances: () => (hasLocalAndroidActivity() ? [handle] : []),
  start: (card, staleDate) => (publish(card, staleDate) ? handle : null),
};
