import { Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  type IssueListInput,
  type IssueListResult,
  type IssueListEntry,
  type IssueRef,
  type IssueDetail,
  type PullRequestListInput,
  type PullRequestListResult,
  type PullRequestRef,
  type PullRequestDetail,
  type PullRequestActivity,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestCheckStatus,
  type IssueScopeRef,
  type IssueCandidates,
  type PullRequestFilterOptionsInput,
  type PullRequestFilterOptions,
} from "@t3tools/contracts";
import { summarizeChangedFiles } from "@t3tools/shared/changedFileKind";
import type { CheckItem } from "@solus/contracts/checks-types";
import type { TaskSummary } from "@solus/contracts/task-types";
import type { ProjectEntry } from "@solus/contracts/types";
import { githubIssueRow, githubPullRequestRow } from "./issue-pr-rows";
import { solus } from "./runtime";

export function sourceScope(id: string) {
  return JSON.stringify([
    solus.sessionCache.scope(),
    solus.connections.state(id)?.sessionGeneration,
  ]);
}

function query<I, A>(read: (hostId: string, input: I) => Promise<A>) {
  const family = Atom.family((key: string) => {
    const [hostId, input]: [string, I] = JSON.parse(key);
    return Atom.make(
      Effect.tryPromise({
        try: () => read(hostId, input),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
    ).pipe(Atom.setIdleTTL(30_000));
  });
  return (target: { environmentId: EnvironmentId; input: I }) =>
    family(JSON.stringify([target.environmentId, target.input, sourceScope(target.environmentId)]));
}

function apiFor(id: string) {
  const connection = solus.connections.connection(id);
  if (!connection || connection.state.readiness !== "ready")
    throw new Error("Connect to this environment to load its data.");
  return connection.api;
}

export const solusPrList = query(
  async (id, input: PullRequestListInput): Promise<PullRequestListResult> => {
    const api = apiFor(id);
    const projects = (await api.listProjects()).filter(
      (p) =>
        p.repositoryKey &&
        (!input.projectId || input.projectId === p.path) &&
        (!input.projectIds || input.projectIds.some((path) => path === p.path)) &&
        (!input.host || p.repositoryKey.split("/")[0] === input.host),
    );
    const after = projects.flatMap((p) => {
      const cursor = input.cursors?.[p.path];
      if (!cursor) return [];
      const [page, token]: [number, string] = JSON.parse(cursor);
      return [{ projectRoot: p.path, page, cursor: token }];
    });
    const ctx = (path: string) => solus.pullRequests.context(path);
    const hosts = [...new Set(projects.map((p) => p.repositoryKey!.split("/")[0]!))];
    const [listings, accounts] = await Promise.all([
      projects.length
        ? api.prListProjects(
            ctx(""),
            input.cursors ? after.map((p) => p.projectRoot) : projects.map((p) => p.path),
            {
              state: input.state === "merged" ? "closed" : input.state,
              ...(input.query ? { query: input.query } : {}),
            },
            after,
          )
        : [],
      Promise.all(
        hosts.map(
          async (host) =>
            [
              host,
              (
                await api
                  .providerViewer(
                    ctx(projects.find((p) => p.repositoryKey!.startsWith(host + "/"))!.path),
                  )
                  .catch(() => null)
              )?.login,
            ] as const,
        ),
      ),
    ]);
    const entries = [],
      errors = [];
    const nextCursors: Record<string, string> = {};
    for (const listing of listings) {
      const p = projects.find((p) => p.path === listing.projectRoot);
      if (!p) continue;
      if ("error" in listing)
        errors.push({
          projectId: ProjectId.make(p.path),
          projectTitle: p.folderName,
          message: listing.error,
        });
      if (!("page" in listing)) continue;
      for (const row of listing.page.items)
        if (input.state === "all" || row.state === input.state)
          entries.push(githubPullRequestRow({ path: p.path, title: p.folderName }, row));
      if (listing.page.hasMore && listing.page.cursor)
        nextCursors[p.path] = JSON.stringify([listing.page.page + 1, listing.page.cursor]);
    }
    const providers = hosts.map((host) => {
      const scoped = projects.filter((p) => p.repositoryKey!.startsWith(host + "/"));
      return {
        host,
        kind: SourceControlProviderKind.make("github"),
        searchesOnHost: true,
        configured: true,
        detail: null,
        projectCount: scoped.length,
        projectIds: scoped.map((p) => ProjectId.make(p.path)),
      };
    });
    return {
      entries,
      errors,
      nextCursors,
      truncated: false,
      providers,
      viewers: Object.fromEntries(
        accounts.flatMap(([host, login]) => (login ? [[host, login]] : [])),
      ),
    };
  },
);

const issueCapabilities = {
  create: false,
  edit: false,
  comment: false,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: false,
};

function issueRow(task: TaskSummary, projects: readonly ProjectEntry[]): IssueListEntry | null {
  const url = task.url && URL.canParse(task.url) ? new URL(task.url) : null;
  const repo = url?.pathname.match(/^\/([^/]+\/[^/]+)\/issues\//)?.[1];
  const project = projects.find(
    (p) => url && repo && p.repositoryKey?.toLowerCase() === (url.host + "/" + repo).toLowerCase(),
  );
  const ref = { path: project?.path ?? "~", title: project?.folderName ?? repo ?? task.providerId };
  const github = githubIssueRow(ref, task);
  if (github) return github;
  if (!url || !task.reference) return null;
  return {
    projectId: ProjectId.make(ref.path),
    projectTitle: ref.title,
    tracker: IssueTrackerKind.make(task.providerId),
    host: url.host,
    scope: task.placements[0]?.sourceKey ?? task.providerId,
    key: task.reference,
    displayKey: task.reference,
    title: task.title,
    url: url.toString(),
    state: { name: task.state.name, category: task.category === "done" ? "closed" : "open" },
    createdAt: new Date(task.createdAt ?? task.updatedAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    closedAt: null,
    author: null,
    assignees: (task.assignees ?? []).map((a) => ({
      login: a.login,
      name: null,
      avatarUrl: a.avatarUrl ?? null,
    })),
    labels: task.labels.map((name) => ({ name, color: null })),
    commentCount: 0,
  };
}

export const solusIssueList = query(async (id, input: IssueListInput): Promise<IssueListResult> => {
  const api = apiFor(id);
  const sources = solus.personal.current().taskSources;
  const search = input.query || (input.involvement && input.involvement !== "all");
  const readTasks = async () => {
    if (search && sources.length)
      return api.tasksSearch(sources, input.query ?? "", input.involvement);
    if (sources.length)
      await api.tasksSources(sources, { refresh: input.refresh ? "force" : "stale" });
    const { tasks } = await api.tasksSidebarSnapshot();
    if (input.involvement && input.involvement !== "all") return [];
    const words = input.query?.trim().toLowerCase().split(/\s+/) ?? [];
    return tasks.filter((task) =>
      words.every((word) =>
        (task.title + " " + (task.reference ?? "")).toLowerCase().includes(word),
      ),
    );
  };
  const [tasks, projects] = await Promise.all([readTasks(), api.listProjects()]);
  const rows = tasks.flatMap((task) => {
    const row = issueRow(task, projects);
    return row ? [{ ...row, solusTaskId: task.id }] : [];
  });
  const scopes = new Map(
    rows.map(({ projectId, tracker, host, scope }) => [
      JSON.stringify([projectId, tracker, host, scope]),
      { projectId, tracker, host, scope },
    ]),
  );
  const groups = new Map(
    rows.map((row) => [
      row.host + " " + row.tracker,
      {
        host: row.host,
        tracker: row.tracker,
        configured: true,
        detail: null,
        capabilities: issueCapabilities,
        projectCount: 1,
      },
    ]),
  );
  const entries = rows.filter(
    (row) =>
      (input.state === "all" || row.state.category === input.state) &&
      (!input.projectId || row.projectId === input.projectId) &&
      !input.excludeProjectIds?.includes(row.projectId) &&
      (!input.host || input.host === row.host) &&
      (!input.assignee || row.assignees.some((a) => a.login === input.assignee)) &&
      (!input.labels || input.labels.every((label) => row.labels.some((l) => l.name === label))),
  );
  entries.sort((a, b) =>
    input.sort === "created"
      ? b.createdAt.localeCompare(a.createdAt)
      : b.updatedAt.localeCompare(a.updatedAt),
  );
  return {
    entries,
    scopes: [...scopes.values()],
    errors: [],
    viewers: {},
    nextCursors: {},
    trackers: [...groups.values()],
  };
});

export const solusIssueDetail = query(
  async (id, input: IssueRef & { taskId?: string }): Promise<IssueDetail> => {
    const api = apiFor(id);
    const matches = (row: IssueListEntry | null) =>
      row?.tracker === input.tracker &&
      row.scope === input.scope &&
      row.key === input.key &&
      (!input.host || row.host === input.host);
    // List rows carry the host's durable task id. A deep link has only the provider reference.
    const taskId =
      input.taskId ??
      (await api.tasksSidebarSnapshot()).tasks.find((task) => matches(issueRow(task, [])))?.id;
    if (!taskId) throw new Error("The task is no longer in this environment.");
    const detail = await api.tasksGet(taskId);
    const row = issueRow(
      detail.task,
      solus.threads
        .projects()
        .filter((p) => p.hostId === id)
        .map((p) => p.project),
    );
    if (!matches(row)) throw new Error("The task reference has changed.");
    if (!row) throw new Error("The task is unavailable.");
    return {
      ...row,
      body: detail.task.body,
      commentCount: detail.comments.length,
      writable: false,
      capabilities: issueCapabilities,
      viewerPermissions: {
        edit: false,
        setState: false,
        comment: false,
        labels: false,
        assignees: false,
      },
      states: [],
      viewer: null,
      comments: detail.comments.map((c) => ({
        id: c.id,
        author: c.externalAuthor ? { login: c.externalAuthor, name: null, avatarUrl: null } : null,
        body: c.body,
        createdAt: new Date(c.createdAt).toISOString(),
        url: null,
      })),
      commentsCursor: null,
      events: [],
      linkedPullRequests: [],
    };
  },
);

export const solusPrDetail = query(
  async (id, input: PullRequestRef): Promise<PullRequestDetail> => {
    const api = apiFor(id);
    const context = solus.pullRequests.context(input.projectId);
    const [{ pullRequest: pr, reviewers }, checksSnapshot] = await Promise.all([
      api.prGetOverview(context, input.number),
      api.prChecks(context, [input.number]).catch(() => null),
    ]);
    const summary = checksSnapshot?.checks.find((check) => check.number === input.number)?.summary;
    const checkRow = (item: CheckItem, required: boolean) => {
      const status: PullRequestCheckStatus = item.inFlight
        ? "pending"
        : item.conclusion === "action_required"
          ? "action-required"
          : item.conclusion === "stale" || item.conclusion === "timed_out" || !item.conclusion
            ? "failure"
            : item.conclusion;
      return { name: item.name, status, description: item.appName, url: item.detailsUrl, required };
    };
    const checks = summary
      ? [
          ...summary.required.map((item) => checkRow(item, true)),
          ...summary.optional.map((item) => checkRow(item, false)),
        ]
      : [];
    if (
      pr.baseRepo.owner + "/" + pr.baseRepo.repo !== input.repository ||
      (input.host && pr.baseRepo.host !== input.host)
    )
      throw new Error("The project now points to a different repository.");
    const project = solus.threads
      .projects()
      .find((p) => p.hostId === id && p.project.path === input.projectId)?.project;
    const row = githubPullRequestRow(
      { path: input.projectId, title: project?.folderName ?? input.repository },
      pr,
    );
    return {
      ...row,
      workspaceRoot: input.projectId,
      body: pr.body,
      changedFiles: pr.changedFiles ?? 0,
      mergedAt: null,
      closedAt: null,
      checks,
      reviewers: reviewers.map((r) => ({
        login: r.login,
        name: null,
        avatarUrl: r.avatarUrl ?? null,
      })),
      mergeCapabilities: { merge: false, squash: false, rebase: false },
      capabilities: {
        diff: true,
        comment: false,
        actions: [],
        mergeMethods: [],
        search: true,
        review: { inlineComment: false, resolve: false, reply: false, verdicts: [] },
        reviewers: { request: false, listCandidates: false },
      },
      viewerPermissions: {
        actions: [],
        comment: false,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      },
    };
  },
);

export const solusPrActivity = query(
  async (id, input: PullRequestRef): Promise<PullRequestActivity> => {
    const api = apiFor(id),
      ctx = solus.pullRequests.context(input.projectId);
    const [events, commits, threads] = await Promise.all([
      api.prListComments(ctx, input.number),
      api.prListCommits(ctx, input.number),
      api.prListThreads(ctx, input.number),
    ]);
    const actor = (login: string, avatarUrl?: string) => ({
      login,
      name: null,
      avatarUrl: avatarUrl ?? null,
    });
    const comments: PullRequestActivity["comments"] = events.flatMap((e) =>
      e.kind === "label"
        ? []
        : [
            {
              id: e.id,
              kind: e.kind === "review" ? "review" : "issue-comment",
              body: e.body,
              createdAt: e.createdAt,
              editedAt: e.editedAt,
              url: e.url ?? null,
              path: null,
              reviewState: e.reviewState ?? null,
              author: actor(e.author, e.authorAvatarUrl),
            },
          ],
    );
    return {
      comments,
      commentCount: comments.length,
      commentsTruncated: false,
      commits: commits.map((c) => ({
        oid: c.sha,
        messageHeadline: c.message,
        committedDate: c.committedAt,
        authors: [actor(c.author)],
      })),
      reviewThreads: threads.map((t) => ({
        id: t.id,
        path: t.filePath,
        line: t.line,
        side: t.side === "LEFT" ? "left" : "right",
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        comments: t.comments.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.createdAt,
          editedAt: c.editedAt,
          url: null,
          author: actor(c.author, c.authorAvatarUrl),
        })),
      })),
    };
  },
);

export const solusPrBreakdown = query(async (id, input: PullRequestRef) =>
  summarizeChangedFiles(
    await apiFor(id).prChangedFiles(solus.pullRequests.context(input.projectId), input.number),
  ),
);

export const solusPrDiff = query(
  async (id, input: PullRequestDiffInput): Promise<PullRequestDiffResult> => {
    const api = apiFor(id),
      ctx = solus.pullRequests.context(input.projectId);
    const target = await api.prOpenReview(ctx, input.number);
    if (
      target.owner + "/" + target.repo !== input.repository ||
      (input.host && input.host !== target.host)
    )
      throw new Error("The project now points to a different repository.");
    return api.prGetDiff(ctx, {
      number: input.number,
      baseSha: target.baseSha,
      headSha: target.headSha,
      cursor: input.cursor,
      commitSha: input.commit,
    });
  },
);

export const solusIssueCandidates = query(
  async (id, input: IssueScopeRef): Promise<IssueCandidates> => {
    const { tasks } = await apiFor(id).tasksSidebarSnapshot();
    const rows = tasks.flatMap((task) => {
      const row = issueRow(task, []);
      return row &&
        row.scope === input.scope &&
        row.tracker === input.tracker &&
        (!input.host || row.host === input.host)
        ? [row]
        : [];
    });
    return {
      labels: [
        ...new Map(
          rows.flatMap((row) =>
            row.labels.map((label) => [label.name, { ...label, description: null }] as const),
          ),
        ).values(),
      ],
      assignees: [
        ...new Map(
          rows.flatMap((row) =>
            row.assignees.map((actor) => [actor.login, { ...actor, id: actor.login }] as const),
          ),
        ).values(),
      ],
      truncated: false,
    };
  },
);
export const solusPrFilterOptions = query(
  async (id, input: PullRequestFilterOptionsInput): Promise<PullRequestFilterOptions> => {
    const api = apiFor(id);
    const projects = (await api.listProjects()).filter(
      (p) =>
        p.repositoryKey &&
        (!input.projectId || p.path === input.projectId) &&
        (!input.projectIds || input.projectIds.some((path) => path === p.path)) &&
        (!input.host || p.repositoryKey.startsWith(input.host + "/")),
    );
    const choices = (
      await Promise.all(
        projects.map((p) =>
          api.prFilterOptions(
            solus.pullRequests.context(p.path),
            input.kind === "labels" ? "label" : "author",
            input.query ?? "",
          ),
        ),
      )
    ).flat();
    const values = [...new Map(choices.map((choice) => [choice.value, choice])).values()];
    return {
      labels:
        input.kind === "labels"
          ? values.map((v) => ({ name: v.value, color: v.color ?? null }))
          : [],
      authors:
        input.kind === "authors"
          ? values.map((v) => ({ login: v.value, name: null, avatarUrl: v.avatarUrl ?? null }))
          : [],
      references: [],
      truncated: false,
    };
  },
);
