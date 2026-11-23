import type {
  IssueRef,
  PullRequestRef,
  IssueUpdateInput,
  PullRequestUpdateInput,
  PullRequestReviewerRequestInput,
  PullRequestLabelChangeInput,
  PullRequestSubmitReviewInput,
  PullRequestReviewPosition,
} from "@t3tools/contracts";
import { hostCommand } from "./host-command";
import { hostQuery } from "./host-query";
import { solus } from "./runtime";
import {
  sourceControlApi,
  readIssueRecord,
  solusIssueDetail,
  solusPrDetail,
  solusPrActivity,
} from "./source-control";

export const taskEditCandidates = hostQuery(async (id, input: IssueRef & { taskId?: string }) => {
  const {
    api,
    detail: { task },
  } = await readIssueRecord(id, input);
  const assignees = await api.tasksListAssigneeCandidates({ taskId: task.id });
  return {
    assignees: assignees.map((a) => ({
      ...a,
      id: a.login,
      name: null,
      avatarUrl: a.avatarUrl ?? null,
    })),
    labels: [],
    truncated: false,
  };
});

export const updateIssue = hostCommand(
  "issues.update",
  "host.use",
  async (id, input: IssueUpdateInput & { taskId?: string }, registry, check) => {
    const {
      api,
      detail: { task },
    } = await readIssueRecord(id, input);
    check();
    await api.tasksUpdate(task.id, {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.labels && { labels: [...input.labels] }),
      ...(input.assignees && { assignees: [...input.assignees] }),
    });
    const { projectId, tracker, scope, key, host } = input;
    const reference = { projectId, tracker, ...(host && { host }), scope, key };
    registry.refresh(solusIssueDetail({ environmentId: id, input: reference }));
    registry.refresh(
      solusIssueDetail({ environmentId: id, input: { ...reference, taskId: task.id } }),
    );
  },
);

async function prSource(id: string, input: PullRequestRef) {
  const api = sourceControlApi(id),
    ctx = solus.pullRequests.context(input.projectId);
  const pr = await api.prGetDetail(ctx, input.number);
  if (
    pr.baseRepo.owner + "/" + pr.baseRepo.repo !== input.repository ||
    (input.host && input.host !== pr.baseRepo.host)
  )
    throw new Error("The checkout now points to a different repository.");
  return { api, ctx, pr };
}
export const prLabelChoices = hostQuery(async (id, input: PullRequestRef) => {
  const { api, ctx, pr } = await prSource(id, input);
  const labels = await api.prListLabelCandidates(ctx, input.number);
  return {
    candidates: labels.map((l) => ({
      ...l,
      description: null,
      isApplied: pr.labels.some((a) => a.name === l.name),
    })),
    truncated: false,
  };
});
export const prReviewerChoices = hostQuery(async (id, input: PullRequestRef) => {
  const { api, ctx, pr } = await prSource(id, input);
  const people = await api.prListReviewerCandidates(ctx, input.number);
  return {
    candidates: people.map((p) => {
      const login = p.kind === "team" ? p.slug : p.login;
      return {
        id: login,
        login,
        kind: p.kind,
        name: p.kind === "team" ? p.name : null,
        avatarUrl: p.avatarUrl ?? null,
        isRequested: p.kind === "team" || !!pr.requestedReviewers?.some((r) => r.login === login),
      };
    }),
    truncated: false,
  };
});

function prCommand<I extends PullRequestRef>(
  label: string,
  write: (source: Awaited<ReturnType<typeof prSource>>, input: I) => Promise<unknown>,
) {
  return hostCommand(label, "host.git.write", async (environmentId, input: I, registry, check) => {
    const source = await prSource(environmentId, input);
    check();
    try {
      await write(source, input);
    } finally {
      const { projectId, repository, number, host } = input;
      const target = {
        environmentId,
        input: { projectId, repository, number, ...(host && { host }) },
      };
      registry.refresh(solusPrDetail(target));
      registry.refresh(solusPrActivity(target));
      registry.refresh(prLabelChoices(target));
      registry.refresh(prReviewerChoices(target));
    }
  });
}
export const editPr = prCommand<PullRequestUpdateInput>(
  "pullRequests.update",
  ({ api, ctx }, i) => {
    if (i.maintainerCanModify !== undefined)
      throw new Error("This host cannot change maintainer access.");
    return api.prUpdate(ctx, i.number, { title: i.title, body: i.body });
  },
);
export const labelPr = prCommand<PullRequestLabelChangeInput>(
  "pullRequests.setLabels",
  ({ api, ctx, pr }, i) => {
    const names = new Set(pr.labels.map((l) => l.name));
    for (const label of i.labels) {
      if (i.applied) names.add(label);
      else names.delete(label);
    }
    return api.prSetLabels(ctx, i.number, [...names]);
  },
);
export const requestPrReviewers = prCommand<PullRequestReviewerRequestInput>(
  "pullRequests.requestReviewers",
  async ({ api, ctx }, i) => {
    if (i.requested) {
      if (i.reviewers.some((r) => r.kind === "team"))
        throw new Error("This host can request reviews from individual users.");
      await api.prRequestReviewers(
        ctx,
        i.number,
        i.reviewers.map((r) => r.id),
      );
    } else
      for (const reviewer of i.reviewers)
        await api.prRemoveRequestedReviewer(ctx, i.number, reviewer.id, reviewer.kind);
  },
);
export const commentPr = prCommand<PullRequestRef & { body: string }>(
  "pullRequests.comment",
  ({ api, ctx }, i) => api.prAddIssueComment(ctx, i.number, i.body),
);
function anchor(p: PullRequestReviewPosition) {
  return p.kind === "deleted" || (p.kind === "context" && p.side === "left")
    ? { line: p.oldLine, side: "LEFT" as const }
    : { line: p.newLine, side: "RIGHT" as const };
}
export const reviewPr = prCommand<PullRequestSubmitReviewInput & { headSha: string }>(
  "pullRequests.submitReview",
  async ({ api, ctx, pr }, i) => {
    if (pr.headSha !== i.headSha)
      throw new Error("The pull request changed. Refresh the diff before submitting.");
    await api.prSubmitReview(ctx, i.number, {
      commitId: i.headSha,
      body: i.body,
      event:
        i.verdict === "approve"
          ? "APPROVE"
          : i.verdict === "request-changes"
            ? "REQUEST_CHANGES"
            : "COMMENT",
      comments: i.comments.map((comment) => {
        const end = anchor(comment.position);
        const start = comment.startPosition && anchor(comment.startPosition);
        if (start && start.side !== end.side)
          throw new Error("Select a range on one side of the diff.");
        return {
          path: comment.path,
          body: comment.body,
          ...end,
          ...(start && { startLine: start.line }),
        };
      }),
    });
  },
);
