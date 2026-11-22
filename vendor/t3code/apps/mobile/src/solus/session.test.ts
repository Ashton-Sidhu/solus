import { EnvironmentId } from "@t3tools/contracts";
import {
  buildThreadListV2Items,
  resolveThreadListV2SwipeActions,
} from "../features/threads/threadListV2";
import { solusListHosts } from "./list-hosts";
import { modelLabel } from "@solus-mobile/features/conversation/lib/run-settings";
import { expect, it } from "vite-plus/test";
import { toThreadShell, type SessionRow } from "./session";

const session: SessionRow = {
  sessionId: "same-id",
  provider: "claude-code",
  projectPath: "/project",
  model: null,
  title: "Original",
  customTitle: "Release notes",
  createdAt: 1000,
  lastActivityAt: 2000,
  branch: "release",
  cwd: "/checkout",
  isWorktree: true,
  status: "running",
};

it("keeps the host and worktree when opening a renamed session", () => {
  expect(toThreadShell("remote", session, "accept-edits")).toMatchObject({
    environmentId: "remote",
    id: "same-id",
    title: "Release notes",
    projectId: "/project",
    branch: "release",
    worktreePath: "/checkout",
    runtimeMode: "auto-accept-edits",
    modelSelection: { instanceId: "claudeAgent", model: "auto" },
  });
});

it("uses the host model label or the Solus catalog name for the composer", () => {
  expect(modelLabel("claude-code", "claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelLabel("codex", "custom", { models: [{ id: "custom", label: "Team model" }] })).toBe(
    "Team model",
  );
});

it("uses the host session state for T3 swipe actions and shelves, including after reconnect", () => {
  const host = EnvironmentId.make("remote");
  const now = "2026-11-22T10:00:00Z";
  const until = Date.parse("2026-11-23T10:00:00Z");
  const hosts = solusListHosts([{ environmentId: host, connectionState: "connected" }]);
  const offline = solusListHosts([{ environmentId: host, connectionState: "connecting" }]);
  const view = { settledAt: null, snoozedUntil: null, snoozeNote: null, archivedAt: null };
  const list = (rowView: NonNullable<SessionRow["view"]>, capabilities = hosts) =>
    buildThreadListV2Items({
      threads: [toThreadShell(host, { ...session, status: "idle", view: rowView })],
      ...capabilities,
      now,
      searchQuery: "",
      environmentId: null,
      settledShelfExpanded: true,
      snoozedShelfExpanded: true,
    });
  expect(hosts.connectedEnvironmentIds.has(host)).toBe(true);
  expect(offline.connectedEnvironmentIds.has(host)).toBe(false);
  expect(
    resolveThreadListV2SwipeActions({
      variant: "card",
      settlementSupported: hosts.settlementEnvironmentIds.has(host),
      snoozeSupported: hosts.snoozeEnvironmentIds.has(host),
      snoozable: true,
    }),
  ).toEqual({ primary: "settle", secondary: "snooze" });
  expect(list({ ...view, settledAt: 2000 }, offline).settledCount).toBe(1);
  expect(list({ ...view, snoozedUntil: until }).snoozedCount).toBe(1);
  expect(list({ ...view, snoozedUntil: 2000 }).snoozedCount).toBe(0);
  expect(list({ ...view, archivedAt: 2000 }).items).toHaveLength(0);
  expect(list(view).items).toHaveLength(1);
});
