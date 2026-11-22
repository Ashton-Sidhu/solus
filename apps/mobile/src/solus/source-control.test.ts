import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, IssueTrackerKind } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { solusIssueDetail, solusIssueList, solusPrList } from "./source-control";

const host = vi.hoisted(() => ({
  listProjects: vi.fn(async () => [
    { path: "/repo", folderName: "App", repositoryKey: "github.com/team/app" },
    { path: "/other", folderName: "Other", repositoryKey: "github.com/team/other" },
  ]),
  prListProjects: vi.fn(),
  providerViewer: vi.fn(async () => ({ login: "reader" })),
  tasksGet: vi.fn(),
  tasksSearch: vi.fn(),
  tasksSidebarSnapshot: vi.fn(),
}));
vi.mock("./runtime", () => ({
  solus: {
    sessionCache: { scope: () => "account" },
    connections: {
      state: () => ({ sessionGeneration: 1 }),
      connection: () => ({ state: { readiness: "ready" }, api: host }),
    },
    personal: {
      current: () => ({ taskSources: [{ kind: "github-repo", owner: "team", repo: "app" }] }),
    },
    pullRequests: { context: (projectRoot: string) => ({ projectRoot }) },
    threads: { projects: () => [] },
  },
}));
const environmentId = EnvironmentId.make("mac");

it("continues only the repository that returned a cursor, even when another project failed", async () => {
  host.prListProjects
    .mockResolvedValueOnce([
      {
        projectRoot: "/repo",
        page: { items: [], page: 1, hasMore: true, cursor: "provider-token" },
      },
      { projectRoot: "/other", error: "Offline" },
    ])
    .mockResolvedValueOnce([]);
  const registry = AtomRegistry.make();
  try {
    const result = await executeAtomQuery(
      registry,
      solusPrList({ environmentId, input: { state: "open" } }),
    );
    expect(host.prListProjects.mock.calls[0]?.[3]).toEqual([]);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("PR list failed");
    expect(result.value.errors[0]?.message).toBe("Offline");
    expect(result.value.viewers["github.com"]).toBe("reader");
    await executeAtomQuery(
      registry,
      solusPrList({ environmentId, input: { state: "open", cursors: result.value.nextCursors } }),
    );
    expect(host.prListProjects.mock.lastCall?.slice(1)).toEqual([
      ["/repo"],
      { state: "open" },
      [{ projectRoot: "/repo", page: 2, cursor: "provider-token" }],
    ]);
  } finally {
    registry.dispose();
  }
});

it("opens a provider search result by its Solus task id even if it is outside the host sidebar", async () => {
  const task = {
    id: "github:node42",
    kind: "issue",
    providerId: "github",
    title: "Crash",
    body: "Steps to reproduce",
    url: "https://github.com/team/app/issues/42",
    state: { name: "Open", category: "open" },
    updatedAt: 1700000000000,
    labels: ["bug"],
  };
  host.tasksSearch.mockResolvedValueOnce([task]);
  host.tasksGet.mockResolvedValueOnce({ task, comments: [] });
  const registry = AtomRegistry.make();
  try {
    const list = await executeAtomQuery(
      registry,
      solusIssueList({
        environmentId,
        input: { state: "open", query: "Crash", involvement: "assigned" },
      }),
    );
    if (list._tag !== "Success") throw new Error("Task search failed");
    expect(list.value.entries[0]).toMatchObject({ key: "42", solusTaskId: task.id });
    expect(host.tasksSearch.mock.lastCall?.slice(1)).toEqual(["Crash", "assigned"]);
    const detail = await executeAtomQuery(
      registry,
      solusIssueDetail({
        environmentId,
        input: {
          projectId: ProjectId.make("/repo"),
          tracker: IssueTrackerKind.make("github"),
          host: "github.com",
          scope: "team/app",
          key: "42",
          taskId: task.id,
        },
      }),
    );
    expect(detail).toMatchObject({
      _tag: "Success",
      value: { title: "Crash", body: "Steps to reproduce" },
    });
    expect(host.tasksSidebarSnapshot).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});
