import { beforeEach, expect, it, vi } from "vite-plus/test";
import { listActions } from "./list-actions";
import { toThreadShell } from "./session";
import { readThreadUndoNotice, dismissThreadUndoNotice } from "../features/home/thread-undo-notice";

const host = vi.hoisted(() => ({
  setSettled: vi.fn(),
  snooze: vi.fn(),
  setArchived: vi.fn(),
  markRead: vi.fn(),
  togglePin: vi.fn(),
  load: vi.fn(),
  refreshSessionRow: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("react-native", () => ({ Alert: { alert: host.alert } }));
vi.mock("../components/ui/Dialog", () => ({ prompt: vi.fn() }));
vi.mock("./runtime", () => ({
  refreshSessionRow: host.refreshSessionRow,
  solus: {
    threadList: { ...host, facts: () => ({ pins: new Map() }) },
    threads: { load: host.load, thread: () => ({ key: "mac/session" }) },
  },
}));

const thread = toThreadShell("mac", {
  sessionId: "session",
  projectPath: "/project",
  provider: "codex",
  title: "Session",
  customTitle: null,
  model: null,
  createdAt: 1000,
  lastActivityAt: 2000,
  branch: null,
  cwd: "/project",
  isWorktree: false,
  status: "idle",
});
beforeEach(() => {
  vi.clearAllMocks();
  dismissThreadUndoNotice();
});

it("settles a session on its own host and undoes the settle and pin removal", async () => {
  await listActions.settleThread({ ...thread, pinnedAt: new Date(2000).toISOString() });
  expect(host.setSettled).toHaveBeenCalledWith("mac", "session", true);
  expect(host.load).not.toHaveBeenCalled();
  expect(host.refreshSessionRow).toHaveBeenCalledWith("mac", "session");
  const notice = readThreadUndoNotice();
  expect(notice?.action).toBe("Settled");
  await notice?.undo();
  expect(host.setSettled).toHaveBeenLastCalledWith("mac", "session", false);
  expect(host.togglePin).toHaveBeenCalledOnce();
});

it("snoozes to the selected instant and invalidates Undo after a manual wake", async () => {
  const until = "2030-01-01T09:00:00-05:00";
  await listActions.snoozeThread(thread, until);
  expect(host.snooze).toHaveBeenCalledWith("mac", "session", Date.parse(until));
  expect(readThreadUndoNotice()?.action).toBe("Snoozed");
  await listActions.unsnoozeThread(thread);
  expect(host.snooze).toHaveBeenLastCalledWith("mac", "session", null);
  expect(readThreadUndoNotice()).toBeNull();
});

it("restores an archived session and reports a rejected action without offering Undo", async () => {
  await listActions.archiveThread(thread);
  await listActions.unarchiveThread(thread);
  expect(host.setArchived.mock.calls).toEqual([
    ["mac", "session", true],
    ["mac", "session", false],
  ]);
  host.setSettled.mockRejectedValueOnce(new Error("Host disconnected"));
  expect(await listActions.settleThread(thread)).toBe(false);
  expect(host.alert).toHaveBeenCalledWith("Could not update the session", "Host disconnected");
  expect(readThreadUndoNotice()).toBeNull();
});

it("marks a session unread and clears it on open without reloading the session list", async () => {
  await listActions.setRead(thread, false);
  await listActions.setRead(thread, true);
  expect(host.markRead.mock.calls).toEqual([
    ["mac", "session", false],
    ["mac", "session", true],
  ]);
  expect(host.load).not.toHaveBeenCalled();
});
