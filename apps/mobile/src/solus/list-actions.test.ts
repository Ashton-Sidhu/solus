import { ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { listActions } from "./list-actions";
import { toThreadShell } from "./session";
import { readThreadUndoNotice, dismissThreadUndoNotice } from "../features/home/thread-undo-notice";

const host = vi.hoisted(() => ({
  registryRead: vi.fn(),
  registrySet: vi.fn(),
  directory: vi.fn(),
  scope: vi.fn(() => "alice"),
  getSessionInfo: vi.fn(),
  generateSessionMetadata: vi.fn(),
  setSessionTitle: vi.fn(),
  setListControls: vi.fn(),
  setSettled: vi.fn(),
  snooze: vi.fn(),
  setArchived: vi.fn(),
  markRead: vi.fn(),
  togglePin: vi.fn(),
  load: vi.fn(),
  refreshSessionRow: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("../state/host-query-scope", () => ({ hostQueryScope: host.scope }));
vi.mock("../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: {} }));
vi.mock("../state/thread-order", () => ({ threadDropBusyAtom: {} }));
vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: { get: host.registryRead, set: host.registrySet },
}));
vi.mock("react-native", () => ({ Alert: { alert: host.alert } }));
vi.mock("../components/ui/Dialog", () => ({ prompt: vi.fn() }));
vi.mock("./runtime", () => ({
  navigationThreadsAtom: {},
  getSolusDirectory: host.directory,
  noteSessionListAction: vi.fn(),
  refreshSessionRow: host.refreshSessionRow,
  solus: {
    personal: { executionPreferences: () => ({}) },
    connections: { connection: () => ({ state: { readiness: "ready" }, api: host }) },
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

it("writes a generated title only to the session and account that requested it", async () => {
  host.getSessionInfo.mockResolvedValue({ firstMessage: "Inspect the repo", cwd: "/repo" });
  host.generateSessionMetadata.mockResolvedValueOnce({
    title: "Inspect repo",
    description: "Review the checkout",
  });
  expect(await listActions.regenerateThreadTitle(thread)).toBe(true);
  expect(host.setSessionTitle).toHaveBeenCalledWith(
    "session",
    "Inspect repo",
    "generated",
    "Review the checkout",
  );
  host.generateSessionMetadata.mockImplementationOnce(async () => {
    host.scope.mockReturnValueOnce("another account");
    return { title: "Late answer" };
  });
  expect(await listActions.regenerateThreadTitle(thread)).toBe(false);
  expect(host.setSessionTitle).toHaveBeenCalledTimes(1);
});

it("writes the move planned for the selected section and skips an older host", async () => {
  const other = { ...thread, id: ThreadId.make("second"), activeOrderKey: "b" };
  const first = { ...thread, activeOrderKey: "a" };
  const listControlEnvironmentIds = new Set(["mac"]);
  host.directory.mockReturnValue({
    threads: [first, other],
    listHosts: { listControlEnvironmentIds },
  });
  host.registryRead
    .mockReturnValueOnce({ holding: false })
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(new Set());
  expect(await listActions.moveThread(first, "down")).toBe(true);
  expect(host.setListControls).toHaveBeenCalledWith("mac", "session", {
    activeOrderKey: expect.any(String),
  });
  expect(host.registrySet.mock.calls.map((call) => call[1])).toEqual([true, false]);
  listControlEnvironmentIds.clear();
  host.registryRead.mockReturnValueOnce({ holding: false }).mockReturnValueOnce(false);
  expect(await listActions.moveThread(first, "up")).toBe(false);
});
