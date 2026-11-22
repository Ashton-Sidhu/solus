import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { HostThreadsState } from "@solus-mobile/features/threads/thread-directory";
import { deriveHomeEmptyState } from "../features/home/home-empty-state";
import type { WorkspaceEnvironment } from "../state/workspaceModel";
import { solusWorkspaceState } from "./workspace-state";

const host: WorkspaceEnvironment = {
  environmentId: EnvironmentId.make("mac"),
  environmentLabel: "Mac",
  displayUrl: "",
  isRelayManaged: false,
  isEnabled: true,
  connectionState: "connected",
  connectionError: null,
  connectionErrorTraceId: null,
};
const empty = { threads: [], projects: [], indexing: false };

it("shows T3's loading state from connection through the first definitive empty list", () => {
  const cases: HostThreadsState[] = [
    { kind: "idle" },
    { kind: "loading", previous: null },
    { kind: "loaded", value: { ...empty, indexing: true } },
  ];
  for (const read of cases) {
    const state = solusWorkspaceState([host], () => read, true, null);
    expect(deriveHomeEmptyState(state, 1)).toMatchObject({
      title: "Loading threads",
      loading: true,
    });
    expect(state.hasLoadedShellSnapshot).toBe(false);
  }
  const state = solusWorkspaceState([host], () => ({ kind: "loaded", value: empty }), true, null);
  expect(deriveHomeEmptyState(state, 1)).toMatchObject({ title: "No threads yet", loading: false });
});

it("keeps the previous snapshot on refresh and shows a first-read failure", () => {
  const state = solusWorkspaceState(
    [host],
    () => ({ kind: "loading", previous: empty }),
    true,
    null,
  );
  expect(state.hasLoadedShellSnapshot).toBe(true);
  const failed = solusWorkspaceState(
    [host],
    () => ({ kind: "error", previous: null, message: "Host refused" }),
    true,
    null,
  );
  expect(deriveHomeEmptyState(failed, 1)).toMatchObject({ loading: false, detail: "Host refused" });
});

it("waits for the second connected host after the first has answered empty", () => {
  const other = { ...host, environmentId: EnvironmentId.make("other") };
  const state = solusWorkspaceState(
    [host, other],
    (id) => (id === "mac" ? { kind: "loaded", value: empty } : { kind: "idle" }),
    true,
    null,
  );
  expect(deriveHomeEmptyState(state, 1).loading).toBe(true);
});
