import { persistQuery } from "@t3tools/client-runtime/state/query-persistence";
import { AsyncResult, Atom } from "effect/reactivity";
import { hostQuery } from "./host-query";
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
  type IssueComment,
  type IssueEvent,
  type IssueLinkedPullRequest,
  type PullRequestListInput,
  PullRequestListResult,
  type PullRequestRef,
  PullRequestDetail,
  PullRequestActivity,
  type PullRequestAction,
  type PullRequestStack,
  PullRequestChangeBreakdown,
  type PullRequestDiffInput,
  type PullRequestDiffFileContentsInput,
  PullRequestDiffResult,
  type PullRequestCheckStatus,
  type IssueScopeRef,
  type IssueCandidates,
  type PullRequestFilterOptionsInput,
  type PullRequestFilterOptions,
} from "@t3tools/contracts";
import { summarizeChangedFiles } from "@t3tools/shared/changedFileKind";
import type { CheckItem } from "@solus/contracts/checks-types";
import type { TaskComment, TaskSummary } from "@solus/contracts/task-types";
import type { TaskProviderData, TaskProviderEvent, TaskProviderPullRequest } from "@solus/contracts/task-data";
import type { ProjectEntry } from "@solus/contracts/types";
import { githubIssueRow, githubPullRequestRow } from "./issue-pr-rows";
import { solus } from "./runtime";

export function sourceControlApi(id: string) {
  const connection = solus.connections.connection(id);
  if (!connection || connection.state.readiness !== "ready")
    throw new Error("Connect to this environment to load its data.");
  return connection.api;
}

function prSearch(input: PullRequestListInput): string {
  const { filters, involvement } = input;
  const terms = [input.query];
  if (input.state === "merged") terms.push("is:merged");
  if (involvement === "authored") terms.push("author:@me");
  if (involvement === "reviewing") terms.push("review-involves:@me");
  if (filters?.author) terms.push(`author:${JSON.stringify(filters.author)}`);
  if (filters?.draft) terms.push(`draft:${filters.draft === "only"}`);
  if (filters?.review) {
    const review = filters.review === "review-required" ? "required" : filters.review.replaceAll("-", "_");
    terms.push(`review:${review}`);
  }
  if (filters?.checks) terms.push(`status:${filters.checks === "passing" ? "success" : "failure"}`);
  for (const labels of filters?.labels ?? []) {
    if (labels.length) terms.push(`label:${labels.map((label) => JSON.stringify(label)).join(",")}`);
  }
  for (const label of filters?.excludedLabels ?? []) terms.push(`-label:${JSON.stringify(label)}`);
  return terms.filter(Boolean).join(" ");
}

export const solusPrList = hostQuery(
  async (id, input: PullRequestListInput): Promise<PullRequestListResult> => {
    const api = sourceControlApi(id);
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
    const query = prSearch(input);
    const hosts = [...new Set(projects.map((p) => p.repositoryKey!.split("/")[0]!))];
    const [listings, accounts] = await Promise.all([
      projects.length
        ? api.prListProjects(
            ctx(""),
            input.cursors ? after.map((p) => p.projectRoot) : projects.map((p) => p.path),
            {
              state: input.state === "merged" ? "closed" : input.state,
              ...(query && { query }),
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
  {
    label: "environment-data:pull-requests:list",
    persistence: persistQuery(PullRequestListResult),
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

const issueSnapshot = hostQuery(
  async (id, input: Omit<IssueListInput, "cursors" | "limit">) => {
    const api = sourceControlApi(id);
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
      return row ? [{
        ...row,
        solusTaskId: task.id,
        ...(task.providerId === "github" && task.state.id && { solusPlanningStatus: task.state.name }),
      }] : [];
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
    return {
      entries,
      scopes: [...scopes.values()],
      errors: [],
      viewers: {},
      trackers: [...groups.values()],
    };
  },
);

type IssueListTarget = { environmentId: EnvironmentId; input: IssueListInput; scope?: string };
const issuePages = Atom.family((key: string) => {
  const target: IssueListTarget = JSON.parse(key);
  const { cursors, limit = 50, ...filters } = target.input;
  const source = issueSnapshot({ ...target, input: filters });
  return Atom.readable(
    (get) => AsyncResult.map(get(source), (snapshot): IssueListResult => {
      const date = (row: IssueListEntry) => filters.sort === "created" ? row.createdAt : row.updatedAt;
      const nextCursors: Record<string, string> = {};
      const groups = new Map<string, typeof snapshot.entries>();
      for (const row of snapshot.entries) {
        const scope = `${row.host} ${JSON.stringify([row.projectId, row.tracker, row.scope])}`;
        if (cursors && !cursors[scope]) continue;
        const group = groups.get(scope);
        if (group) group.push(row);
        else groups.set(scope, [row]);
      }
      const entries = [];
      for (const [scope, group] of groups) {
        const cursor = cursors?.[scope];
        const key = (row: typeof group[number]) => JSON.stringify([date(row), row.solusTaskId]);
        const sorted = group.filter((row) => cursor === undefined || key(row) < cursor)
          .sort((left, right) => key(left) < key(right) ? 1 : key(left) > key(right) ? -1 : 0);
        const slice = sorted.slice(0, limit);
        entries.push(...slice);
        const last = slice.at(-1);
        if (last && sorted.length > limit) nextCursors[scope] = key(last);
      }
      return { ...snapshot, entries: entries.sort((a, b) => date(b).localeCompare(date(a))), nextCursors };
    }),
    (refresh) => refresh(source),
  );
});

export const solusIssueList = (target: IssueListTarget) => issuePages(JSON.stringify(target));

export const solusIssueDetail = hostQuery(
  async (
    id,
    input: IssueRef & { taskId?: string; issueUrl?: string },
  ): Promise<IssueDetail & {
    writableFields: TaskSummary["writableFields"];
    events: ReadonlyArray<ProviderIssueEvent>;
    providerPullRequests?: ReadonlyArray<IssueProviderPullRequest>;
    providerComments?: ReadonlyArray<IssueComment>;
    providerTaskId?: string;
    timelineOnly?: true;
  }> => {
    const external = input.issueUrl
      ? await sourceControlApi(id).tasksResolve(input.issueUrl, { detailsOnly: true })
      : null;
    const { detail, row } = external
      ? { detail: external.details, row: issueRow(external.details.task, []) }
      : await readIssueRecord(id, input);
    if (!row) throw new Error("The issue is unavailable.");
    const writableFields = external ? [] : detail.task.writableFields;
    const statusOptions = external ? undefined : detail.statusOptions;
    return {
      ...row,
      body: detail.task.body,
      commentCount: detail.comments.length,
      writableFields,
      writable: writableFields.length > 0 || statusOptions?.canSetStatus === true,
      capabilities: external
        ? { ...issueCapabilities, events: true }
        : { ...issueCapabilities, edit: true, labels: true, assignees: true },
      viewerPermissions: {
        edit:
          writableFields.includes("title") || writableFields.includes("body"),
        setState: statusOptions?.canSetStatus === true,
        comment: false,
        labels: writableFields.includes("labels"),
        assignees: writableFields.includes("assignee"),
      },
      states: statusOptions?.columns.map(({ name, category }) => ({
        name, category: category === "done" ? "closed" : "open",
      })) ?? [],
      viewer: null,
      comments: detail.comments.map(issueComment),
      commentsCursor: null,
      ...(external?.inspection
        ? issueProviderActivity(external.inspection)
        : {
          events: [],
          providerTaskId: detail.task.id,
          ...(detail.providerMetadata && {
            timelineOnly: true as const,
            providerPullRequests: issueProviderPullRequests(detail.providerMetadata.pullRequests),
          }),
        }),
      linkedPullRequests: [],
    };
  },
);

export type IssueProviderPullRequest = Omit<IssueLinkedPullRequest, "state"> & {
  state: IssueLinkedPullRequest["state"] | "unknown";
};

export type ProviderIssueEvent = IssueEvent & { providerText?: string; providerLink?: TaskProviderEvent["link"] };

function issueComment(comment: TaskComment): IssueComment {
  return {
    id: comment.providerCommentId ?? comment.id,
    author: comment.externalAuthor ? { login: comment.externalAuthor, name: null, avatarUrl: null } : null,
    body: comment.body,
    createdAt: new Date(comment.createdAt).toISOString(),
    url: null,
  };
}

function issueProviderPullRequests(pullRequests: TaskProviderPullRequest[]) {
  return pullRequests.map((pullRequest) => ({
    ...pullRequest,
    repository: new URL(pullRequest.url).pathname.split("/").slice(1, 3).join("/"),
    isDraft: false,
  }));
}

function issueProviderActivity(inspection: TaskProviderData) {
  return {
    events: inspection.events.map((event) => ({
      id: event.id,
      kind: "state-changed" as const,
      actor: event.actor ? { login: event.actor, name: null, avatarUrl: null } : null,
      createdAt: new Date(event.at).toISOString(),
      detail: null,
      providerText: event.text,
      providerLink: event.link,
    })),
    historyCursor: inspection.historyCursor,
    providerComments: inspection.comments?.map(issueComment) ?? [],
    providerPullRequests: issueProviderPullRequests(inspection.pullRequests),
  };
}

export const solusIssueActivity = hostQuery(async (id, input: { taskId: string; cursor?: string; timelineOnly?: true }) => {
  const inspection = await sourceControlApi(id).tasksGet(input.taskId, {
    section: "provider",
    ...(input.cursor && { cursor: input.cursor }),
    ...(input.timelineOnly && { timelineOnly: true }),
  });
  if ("task" in inspection) throw new Error("Update the task host to read provider activity.");
  return issueProviderActivity(inspection);
});

const SOLUS_PR_ACTIONS = [
  "merge", "close", "reopen", "ready", "draft", "enable-auto-merge", "disable-auto-merge",
] satisfies PullRequestAction[];

export const solusPrStack = hostQuery(
  async (id, input: PullRequestRef): Promise<PullRequestStack | null> => {
    const api = sourceControlApi(id);
    const repo = await solus.pullRequests.repository(id, input.projectId);
    if (`${repo.owner}/${repo.repo}`.toLowerCase() !== input.repository.toLowerCase() || (input.host && repo.host !== input.host))
      throw new Error("The project now points to a different repository.");
    const stack = await api.prGetStack({ repo, number: input.number });
    return stack && {
      ...stack,
      id: String(stack.number),
      layers: stack.layers.map((layer) => ({
        number: layer.number,
        title: layer.title,
        state: layer.state,
        isDraft: layer.draft,
        headBranch: layer.headRef,
        headSha: layer.headSha,
      })),
    };
  },
);

export const solusPrDetail = hostQuery(
  async (id, input: PullRequestRef): Promise<PullRequestDetail> => {
    const api = sourceControlApi(id);
    const repo = await solus.pullRequests.repository(id, input.projectId);
    const [{ pullRequest: pr, reviewers }, checksSnapshot] = await Promise.all([
      api.prGetOverview({ repo, number: input.number }, { includeCommits: false }),
      api.prChecks(repo, [input.number]).catch(() => null),
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
      headSha: pr.headSha,
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
      autoMergeEnabled: pr.autoMergeEnabled,
      autoMergeMethod: pr.autoMergeMethod,
      mergeCapabilities: {
        merge: pr.capabilities.mergeMethods.includes("merge"),
        squash: pr.capabilities.mergeMethods.includes("squash"),
        rebase: pr.capabilities.mergeMethods.includes("rebase"),
      },
      capabilities: {
        diff: true,
        comment: true,
        labels: pr.capabilities.labelManagement,
        ...(pr.capabilities.viewedFiles && { viewedFiles: "host" as const }),
        edit: { changeRequest: true, maintainerEdits: false, comment: false },
        actions: SOLUS_PR_ACTIONS.filter((action) => pr.capabilities.actions.includes(action)),
        mergeMethods: pr.capabilities.mergeMethods,
        stacks: pr.capabilities.actions.includes("merge-stack"),
        stackActions: pr.capabilities.actions.includes("merge-stack"),
        stackAutoMerge: pr.capabilities.actions.includes("enable-stack-auto-merge")
          && pr.viewerPermissions.actions.includes("enable-stack-auto-merge"),
        search: true,
        review: {
          inlineComment: pr.capabilities.inlineComments,
          rangeComment: pr.capabilities.inlineComments,
          resolve: false,
          reply: false,
          verdicts: pr.capabilities.reviewVerdicts,
        },
        reviewers: {
          request: pr.capabilities.reviewerRequests,
          listCandidates: pr.capabilities.reviewerCandidates,
        },
      },
      viewerPermissions: {
        actions: SOLUS_PR_ACTIONS.filter((action) => pr.viewerPermissions.actions.includes(action)),
        comment: pr.viewerPermissions.comment,
        labels: pr.viewerPermissions.manageLabels,
        editChangeRequest: pr.viewerPermissions.editPullRequest ?? false,
        resolve: false,
        verdicts: pr.viewerPermissions.reviewVerdicts,
        requestReviewers: pr.viewerPermissions.requestReviewers,
      },
    };
  },
  {
    label: "environment-data:pull-requests:detail",
    persistence: persistQuery(PullRequestDetail),
    staleTimeMs: 60_000,
  },
);

export const solusPrActivity = hostQuery(
  async (id, input: PullRequestRef): Promise<PullRequestActivity> => {
    const api = sourceControlApi(id),
      pr = { repo: await solus.pullRequests.repository(id, input.projectId), number: input.number };
    const [events, commits, threads] = await Promise.all([
      api.prListComments(pr),
      api.prListCommits(pr),
      api.prListThreads(pr),
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
  {
    label: "environment-data:pull-requests:activity",
    persistence: persistQuery(PullRequestActivity),
    staleTimeMs: 60_000,
  },
);

export const solusPrBreakdown = hostQuery(
  async (id, input: PullRequestRef): Promise<PullRequestChangeBreakdown> =>
    summarizeChangedFiles(
      await sourceControlApi(id).prChangedFiles({
        repo: await solus.pullRequests.repository(id, input.projectId),
        number: input.number,
      }),
    ),
  {
    label: "environment-data:pull-requests:change-breakdown",
    persistence: persistQuery(PullRequestChangeBreakdown),
    staleTimeMs: 60_000,
  },
);

export async function prDiffSource(id: string, input: PullRequestRef & { expectedHead?: string }) {
  const api = sourceControlApi(id);
  const ctx = solus.pullRequests.context(input.projectId);
  const pr = { repo: await solus.pullRequests.repository(id, input.projectId), number: input.number };
  const target = await api.prOpenReview(pr);
  if (
    target.owner + "/" + target.repo !== input.repository ||
    (input.host && input.host !== target.host)
  )
    throw new Error("The project now points to a different repository.");
  if (input.expectedHead && target.headSha !== input.expectedHead)
    throw new Error("The pull request changed. Refresh the diff.");
  return { api, ctx, pr, target };
}

export const prDiffContents = hostQuery(
  async (id, input: PullRequestDiffFileContentsInput & { expectedHead?: string }) => {
    const { api, pr, target } = await prDiffSource(id, input);
    return api.prGetDiffFileContents({
      ...pr,
      baseSha: target.baseSha,
      headSha: target.headSha,
      commitSha: input.commit,
      oldPath: input.oldPath,
      newPath: input.newPath,
      changeType: input.changeType,
    });
  },
  30_000,
  60_000,
);

export const solusPrDiff = hostQuery(
  async (
    id,
    input: PullRequestDiffInput & { expectedHead?: string },
  ): Promise<PullRequestDiffResult> => {
    const { api, pr, target } = await prDiffSource(id, input);
    return api.prGetDiff({
      ...pr,
      baseSha: target.baseSha,
      headSha: target.headSha,
      cursor: input.cursor,
      commitSha: input.commit,
    });
  },
  {
    label: "environment-data:pull-requests:diff",
    persistence: persistQuery(PullRequestDiffResult),
    staleTimeMs: 60_000,
  },
);

export const solusIssueCandidates = hostQuery(
  async (id, input: IssueScopeRef & { query?: string }): Promise<IssueCandidates> => {
    const api = sourceControlApi(id);
    // A bound GitHub checkout can search the repository's labels, including unused ones.
    if (
      input.query !== undefined &&
      input.tracker === "github" &&
      input.projectId !== "~" &&
      input.host
    ) {
      const project = solus.threads
        .projects()
        .find((p) => p.hostId === id && p.project.path === input.projectId)?.project;
      if (
        project?.repositoryKey?.toLowerCase() === (input.host + "/" + input.scope).toLowerCase()
      ) {
        const labels = await api.prFilterOptions(
          solus.pullRequests.context(input.projectId),
          "label",
          input.query,
        );
        return {
          labels: labels.map((label) => ({
            name: label.value,
            color: label.color ?? null,
            description: null,
          })),
          assignees: [],
          truncated: labels.length === 50,
        };
      }
    }
    const { tasks } = await api.tasksSidebarSnapshot();
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
export const solusPrFilterOptions = hostQuery(
  async (id, input: PullRequestFilterOptionsInput): Promise<PullRequestFilterOptions> => {
    const api = sourceControlApi(id);
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
  5 * 60_000,
);

function issueMatches(input: IssueRef, row: IssueListEntry | null) {
  return (
    row?.tracker === input.tracker &&
    row.scope === input.scope &&
    row.key === input.key &&
    (!input.host || row.host === input.host)
  );
}
export async function readIssueRecord(id: string, input: IssueRef & { taskId?: string }) {
  const api = sourceControlApi(id);
  const taskId =
    input.taskId ??
    (await api.tasksSidebarSnapshot()).tasks.find((task) => issueMatches(input, issueRow(task, [])))
      ?.id;
  if (!taskId) throw new Error("The task is no longer in this environment.");
  const detail = await api.tasksGet(taskId);
  const row = issueRow(
    detail.task,
    solus.threads
      .projects()
      .filter((p) => p.hostId === id)
      .map((p) => p.project),
  );
  if (!issueMatches(input, row)) throw new Error("The task reference has changed.");
  if (!row) throw new Error("The task is unavailable.");
  return { api, detail, row };
}
