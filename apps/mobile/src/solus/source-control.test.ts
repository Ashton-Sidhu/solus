import { hostQueryScope } from "../state/host-query-scope";
import { labelPr, reviewPr, updateIssue } from "./source-control-actions";
import { executeAtomQuery, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, IssueTrackerKind } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { issueIdentity, issueTarget } from "../features/issues/issueParams";
import { prDiffContents, solusIssueActivity, solusIssueDetail, solusIssueList, solusPrList } from "./source-control";

const host = vi.hoisted(() => ({
  listProjects: vi.fn(async () => [
    { path: "/repo", folderName: "App", repositoryKey: "github.com/team/app" },
    { path: "/other", folderName: "Other", repositoryKey: "github.com/team/other" },
  ]),
  prListProjects: vi.fn(),
  prGetDetail: vi.fn(),
  prSetLabels: vi.fn(),
  prSubmitReview: vi.fn(),
  prOpenReview: vi.fn(),
  prGetDiffFileContents: vi.fn(),
  tasksUpdate: vi.fn(),
  generation: 1,
  accountScope: "account",
  readiness: "ready",
  allowed: true,
  changes: new Set<() => void>(),
  providerViewer: vi.fn(async () => ({ login: "reader" })),
  tasksGet: vi.fn(),
  tasksResolve: vi.fn(),
  tasksSearch: vi.fn(),
  tasksSidebarSnapshot: vi.fn(),
}));
vi.mock("./runtime", async () => {
  const { PullRequestCache, memoryPullRequestCacheDatabase } =
    await import("@solus/client-core/pull-request-cache");
  return {
    solus: {
      account: { changes: { subscribe: () => () => {} } },
      sessionCache: { scope: () => host.accountScope },
      pullRequestCache: new PullRequestCache(memoryPullRequestCacheDatabase()),
      connections: {
        changes: {
          subscribe(listener: () => void) {
            host.changes.add(listener);
            return () => host.changes.delete(listener);
          },
        },
        state: () => ({ sessionGeneration: host.generation, readiness: host.readiness }),
        readiness: () => ({ readiness: host.readiness }),
        may: () => host.allowed,
        connection: () => ({ state: { readiness: host.readiness }, api: host }),
      },
      personal: {
        current: () => ({ taskSources: [{ kind: "github-repo", owner: "team", repo: "app" }] }),
      },
      pullRequests: { context: (projectRoot: string) => ({ projectRoot }) },
      threads: { projects: () => [] },
    },
  };
});
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

it("shows saved PR rows on reconnect and during a live refresh, only in the scope that read them", async () => {
  const target = { environmentId, input: { state: "open" as const, query: "cache-test" } };
  const source = solusPrList(target);
  const listing = (title: string) => [
    {
      projectRoot: "/repo",
      page: {
        page: 1,
        hasMore: false,
        items: [
          {
            number: 7,
            title,
            url: "https://github.com/team/app/pull/7",
            baseRepo: { owner: "team", repo: "app", host: "github.com" },
            headRef: "fix",
            baseRef: "main",
            state: "open",
            draft: false,
            labels: [],
            additions: 3,
            deletions: 1,
            createdAt: "2026-11-20T00:00:00Z",
            updatedAt: "2026-11-21T00:00:00Z",
          },
        ],
      },
    },
  ];
  host.prListProjects.mockResolvedValueOnce(listing("Saved title"));
  const first = AtomRegistry.make();
  try {
    expect(await executeAtomQuery(first, source)).toMatchObject({
      _tag: "Success",
      value: { entries: [{ title: "Saved title" }] },
    });
  } finally {
    first.dispose();
  }
  const opened = AtomRegistry.make();
  try {
    host.generation++;
    host.readiness = "reconnecting";
    const calls = host.prListProjects.mock.calls.length;
    expect(await executeAtomQuery(opened, source)).toMatchObject({
      _tag: "Success",
      value: { entries: [{ title: "Saved title", additions: 3 }] },
    });
    expect(host.prListProjects).toHaveBeenCalledTimes(calls);
    host.readiness = "unreachable";
    host.accountScope = "other organization";
    const other = solusPrList({ ...target, scope: hostQueryScope(environmentId) });
    expect((await executeAtomQuery(opened, other))._tag).toBe("Failure");
    expect(AsyncResult.value(opened.get(other))._tag).toBe("None");
    host.accountScope = "account";
    host.readiness = "refused";
    const refused = solusPrList({ ...target, scope: hostQueryScope(environmentId) });
    expect((await executeAtomQuery(opened, refused))._tag).toBe("Failure");
    expect(AsyncResult.value(opened.get(refused))._tag).toBe("None");
  } finally {
    opened.dispose();
    host.accountScope = "account";
    host.readiness = "ready";
  }

  const live = AtomRegistry.make();
  const started = Promise.withResolvers<void>();
  const refreshed = Promise.withResolvers<ReturnType<typeof listing>>();
  host.prListProjects.mockImplementationOnce(() => {
    started.resolve();
    return refreshed.promise;
  });
  try {
    live.mount(source);
    const settled = executeAtomQuery(live, source);
    await started.promise;
    expect(live.get(source)).toMatchObject({
      _tag: "Success",
      waiting: true,
      value: { entries: [{ title: "Saved title" }] },
    });
    refreshed.resolve(listing("New title"));
    expect(await settled).toMatchObject({
      _tag: "Success",
      waiting: false,
      value: { entries: [{ title: "New title" }] },
    });
    host.allowed = false;
    for (const listener of [...host.changes]) listener();
    expect((await executeAtomQuery(live, source))._tag).toBe("Failure");
    expect(AsyncResult.value(live.get(source))._tag).toBe("None");
  } finally {
    host.allowed = true;
    live.dispose();
  }
});

it("opens a provider search result by its Solus task id even if it is outside the host sidebar", async () => {
  const task = {
    id: "github:node42",
    kind: "issue",
    providerId: "github",
    writableFields: [],
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

const pullRequest = {
  projectId: ProjectId.make("/repo"),
  repository: "team/app",
  number: 7,
  host: "github.com",
};
const pr = {
  baseRepo: { owner: "team", repo: "app", host: "github.com" },
  headSha: "reviewed",
  labels: [{ name: "keep" }],
};
const quiet = { reportFailure: false };

it("applies a label change to the current host labels", async () => {
  const registry = AtomRegistry.make();
  try {
    host.prGetDetail.mockResolvedValueOnce(pr);
    const result = await runAtomCommand(
      registry,
      labelPr,
      { environmentId, input: { ...pullRequest, labels: ["bug"], applied: true } },
      quiet,
    );
    expect(result._tag).toBe("Success");
    expect(host.prSetLabels).toHaveBeenCalledWith({ projectRoot: "/repo" }, 7, ["keep", "bug"]);
  } finally {
    registry.dispose();
  }
});

it("posts a review against the selected revision and keeps deleted lines on the left", async () => {
  const registry = AtomRegistry.make();
  const input = {
    ...pullRequest,
    headSha: "reviewed",
    verdict: "request-changes" as const,
    body: "Please revise",
    comments: [
      {
        path: "a.ts",
        body: "Keep this",
        position: { kind: "deleted" as const, oldLine: 8 },
        startPosition: { kind: "context" as const, oldLine: 6, newLine: 2, side: "left" as const },
      },
    ],
  };
  try {
    host.prGetDetail.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, headSha: "pushed" });
    expect((await runAtomCommand(registry, reviewPr, { environmentId, input }, quiet))._tag).toBe(
      "Success",
    );
    expect(host.prSubmitReview).toHaveBeenCalledWith({ projectRoot: "/repo" }, 7, {
      commitId: "reviewed",
      event: "REQUEST_CHANGES",
      body: "Please revise",
      comments: [{ path: "a.ts", body: "Keep this", side: "LEFT", line: 8, startLine: 6 }],
    });
    expect((await runAtomCommand(registry, reviewPr, { environmentId, input }, quiet))._tag).toBe(
      "Failure",
    );
    host.prGetDetail.mockResolvedValueOnce(pr);
    const crossSideRange = {
      ...input,
      comments: input.comments.map((comment) => ({
        ...comment,
        startPosition: { kind: "added" as const, newLine: 6 },
      })),
    };
    const crossSideResult = await runAtomCommand(
      registry,
      reviewPr,
      { environmentId, input: crossSideRange },
      quiet,
    );
    expect(crossSideResult._tag).toBe("Failure");
    expect(host.prSubmitReview).toHaveBeenCalledTimes(1);
  } finally {
    registry.dispose();
  }
});

it("does not send a queued write after the host connection changes during its read", async () => {
  const registry = AtomRegistry.make();
  try {
    host.prGetDetail.mockImplementationOnce(async () => {
      host.generation++;
      return pr;
    });
    host.prSetLabels.mockClear();
    const result = await runAtomCommand(
      registry,
      labelPr,
      { environmentId, input: { ...pullRequest, labels: ["bug"], applied: false } },
      quiet,
    );
    expect(result._tag).toBe("Failure");
    expect(host.prSetLabels).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});

it("reads both sides of a renamed review file from the revision shown", async () => {
  const registry = AtomRegistry.make();
  try {
    host.prOpenReview.mockResolvedValueOnce({
      ...pr.baseRepo,
      headSha: "reviewed",
      baseSha: "base",
    });
    host.prGetDiffFileContents.mockResolvedValueOnce({ oldContents: "old", newContents: "new" });
    const result = await executeAtomQuery(
      registry,
      prDiffContents({
        environmentId,
        input: {
          ...pullRequest,
          expectedHead: "reviewed",
          oldPath: "old.ts",
          newPath: "new.ts",
          changeType: "rename-changed",
        },
      }),
    );
    expect(result).toMatchObject({
      _tag: "Success",
      value: { oldContents: "old", newContents: "new" },
    });
    expect(host.prGetDiffFileContents.mock.lastCall?.[1]).toMatchObject({
      baseSha: "base",
      headSha: "reviewed",
      oldPath: "old.ts",
      newPath: "new.ts",
    });
  } finally {
    registry.dispose();
  }
});

it("opens a pasted issue URL before provider activity loads and keeps the issue read-only", async () => {
  const registry = AtomRegistry.make();
  const issueUrl = "https://github.com/team/other/issues/42";
  const taskId = "github:outside42";
  const previousReads = host.tasksGet.mock.calls.length;
  host.tasksResolve.mockResolvedValueOnce({
    details: {
      task: {
        id: taskId,
        kind: "issue",
        providerId: "github",
        title: "External issue",
        body: "Issue description",
        url: issueUrl,
        state: { name: "Open", category: "open" },
        updatedAt: 1700000000000,
        labels: [],
        writableFields: ["title", "body", "labels", "assignee"],
      },
      comments: [{ id: "1", body: "A comment", createdAt: 1700000000000 }],
    },
    readOnly: true,
  });
  host.tasksGet.mockResolvedValueOnce({
    events: [{
      id: "2", actor: "reader", text: "added a commit that references this issue", at: 1700000000000,
      link: { label: "Fix issue (8a81adf)", url: "https://github.com/team/other/commit/8a81adf" },
    }],
    historyCursor: "older-activity",
    pullRequests: [{
      url: "https://github.com/team/other/pull/12",
      number: 12,
      title: "Fix the issue",
      state: "open",
      closesIssue: true,
    }],
  });
  try {
    const result = await executeAtomQuery(
      registry,
      solusIssueDetail(issueTarget({
        environmentId,
        projectId: "~",
        tracker: "external",
        scope: "github.com",
        issueKey: issueUrl,
        issueUrl,
      })),
    );
    expect(host.tasksResolve).toHaveBeenCalledWith(issueUrl, { detailsOnly: true });
    expect(host.tasksGet.mock.calls).toHaveLength(previousReads);
    expect(result).toMatchObject({
      _tag: "Success",
      value: {
        displayKey: "#42",
        scope: "team/other",
        body: "Issue description",
        comments: [{ body: "A comment" }],
        events: [],
        providerTaskId: taskId,
        writable: false,
        writableFields: [],
        viewerPermissions: { edit: false, comment: false, labels: false, assignees: false },
      },
    });
    const activity = await executeAtomQuery(
      registry,
      solusIssueActivity({ environmentId, input: { taskId } }),
    );
    expect(host.tasksGet.mock.lastCall).toEqual([taskId, { section: "provider" }]);
    expect(activity).toMatchObject({
      _tag: "Success",
      value: {
        events: [{ providerLink: { label: "Fix issue (8a81adf)", url: "https://github.com/team/other/commit/8a81adf" } }],
        historyCursor: "older-activity",
        providerPullRequests: [{ repository: "team/other", number: 12, closesIssue: true }],
      },
    });
  } finally {
    registry.dispose();
  }
});

it("preserves the task identity in edit sheets and updates only the selected field", async () => {
  const registry = AtomRegistry.make();
  const task = {
    id: "github:42",
    kind: "issue",
    providerId: "github",
    title: "Old",
    url: "https://github.com/team/app/issues/42",
    state: { name: "Open", category: "open" },
    updatedAt: 1700000000000,
    labels: [],
    writableFields: ["body"],
  };
  try {
    const params = {
      environmentId,
      projectId: "/repo",
      tracker: "github",
      host: "github.com",
      scope: "team/app",
      issueKey: "42",
      solusTaskId: task.id,
    };
    const target = issueTarget(issueIdentity(params));
    expect(target.input.taskId).toBe(task.id);
    host.tasksGet
      .mockResolvedValueOnce({ task })
      .mockResolvedValueOnce({ task: { ...task, url: "https://github.com/team/other/issues/42" } });
    const input = { ...target.input, body: "" };
    expect(
      (await runAtomCommand(registry, updateIssue, { environmentId, input }, quiet))._tag,
    ).toBe("Success");
    expect(host.tasksUpdate).toHaveBeenCalledWith(task.id, { body: "" });
    expect(
      (await runAtomCommand(registry, updateIssue, { environmentId, input }, quiet))._tag,
    ).toBe("Failure");
    expect(host.tasksUpdate).toHaveBeenCalledTimes(1);
  } finally {
    registry.dispose();
  }
});
