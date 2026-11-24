import type {
  IssueRef,
  PullRequestRef,
  PullRequestActionInput,
  IssueUpdateInput,
  IssueSetStateInput,
  PullRequestUpdateInput,
  PullRequestReviewerRequestInput,
  PullRequestLabelChangeInput,
  PullRequestSubmitReviewInput,
  PullRequestReviewPosition,
  PullRequestFilesViewedResult,
  PullRequestSetFilesViewedInput,
  PullRequestSummary,
} from "@t3tools/contracts";
import { hostCommand } from "./host-command";
import { hostQuery } from "./host-query";
import { solus } from "./runtime";
import { applyPrListReply } from "./pr-list-cache";
import { githubPullRequestRow } from "./issue-pr-rows";
import type { PullRequest } from "@solus/contracts/providers";
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

export const moveIssue = hostCommand(
  "issues.setState",
  "host.use",
  async (id, input: IssueSetStateInput & { taskId?: string }, registry, check) => {
    const { api, detail } = await readIssueRecord(id, input);
    const status = detail.statusOptions?.columns.find(({ name }) => name === input.state);
    if (!detail.statusOptions?.canSetStatus || !status)
      throw new Error("This issue cannot move to that status.");
    check();
    await api.tasksMove(detail.task.id, { statusId: status.id });
    const { projectId, tracker, host, scope, key } = input;
    registry.refresh(solusIssueDetail({ environmentId: id, input: { projectId, tracker, ...(host && { host }), scope, key, ...(input.taskId && { taskId: input.taskId }) } }));
  },
);

async function prTarget(id: string, input: PullRequestRef) {
  const api = sourceControlApi(id);
  const repo = await solus.pullRequests.repository(id, input.projectId);
  if (
    `${repo.owner}/${repo.repo}`.toLowerCase() !== input.repository.toLowerCase() ||
    (input.host && input.host.toLowerCase() !== repo.host.toLowerCase())
  )
    throw new Error("The checkout now points to a different repository.");
  return { api, ref: { repo, number: input.number } };
}

async function prSource(id: string, input: PullRequestRef) {
  const { api, ref } = await prTarget(id, input);
  const pr = await api.prGetDetail(ref);
  if (
    pr.baseRepo.owner + "/" + pr.baseRepo.repo !== input.repository ||
    (input.host && input.host !== pr.baseRepo.host)
  )
    throw new Error("The checkout now points to a different repository.");
  return { api, ctx: solus.pullRequests.context(input.projectId), ref, pr };
}

export const prFilesViewed = hostQuery(async (id, input: PullRequestRef & { headSha?: string }): Promise<PullRequestFilesViewedResult> => {
  const { api, ref } = await prTarget(id, input);
  const result = await api.prViewedFiles(ref);
  return { files: result.files, truncated: !result.complete };
}, 0);

export const setPrFilesViewed = hostCommand(
  "pullRequests.setFilesViewed",
  "host.use",
  async (id, input: PullRequestSetFilesViewedInput & { expectedHeadSha?: string }, _registry, check) => {
    const { api, ref } = await prTarget(id, input);
    if (input.files.some((file) => file.revision !== undefined))
      throw new Error("This host cannot apply viewed state to a specific file revision.");
    if (input.expectedHeadSha && (await api.prGetDetail(ref)).headSha !== input.expectedHeadSha)
      throw new Error("The pull request changed. Refresh the diff before marking files viewed.");
    check();
    await api.prSetFilesViewed(ref, input.files.map(({ path, viewed }) => ({ path, viewed })));
  },
);

export const prLabelChoices = hostQuery(async (id, input: PullRequestRef) => {
  const { api, ref, pr } = await prSource(id, input);
  const labels = await api.prListLabelCandidates(ref);
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
  const { api, ref, pr } = await prSource(id, input);
  const people = await api.prListReviewerCandidates(ref);
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

function prCommand<I extends PullRequestRef, Reply = unknown>(
  label: string,
  write: (source: Awaited<ReturnType<typeof prSource>>, input: I) => Promise<Reply>,
  listReply?: (result: Reply) => PullRequest | void,
) {
  return hostCommand(label, "host.git.write", async (environmentId, input: I, registry, check) => {
    const source = await prSource(environmentId, input);
    check();
    try {
      const result = await write(source, input);
      if (listReply) {
        const reply = listReply(result);
        check();
        const summary: PullRequestSummary | undefined = reply
          ? githubPullRequestRow({ path: input.projectId, title: "" }, reply) : undefined;
        applyPrListReply(registry, environmentId, input, summary);
        return summary;
      }
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
const writePrAction = async ({ api, ref, pr }: Awaited<ReturnType<typeof prSource>>, input: PullRequestActionInput) => {
  const { action, stackNumber, expectedHeadSha, mergeMethod: method } = input;
  if (action === "close" || action === "reopen" || action === "ready" || action === "draft") {
    return api.prUpdateLifecycle(ref, action, expectedHeadSha ?? pr.headSha);
  }
  if (action === "disable-auto-merge") {
    if (stackNumber === undefined) await api.prDisableAutoMerge(ref);
    else await api.prDisableStackAutoMerge(ref, stackNumber);
    return;
  }
  if (action !== "merge" && action !== "enable-auto-merge")
    throw new Error("This host does not support this pull request action.");
  if (!method || method === "fast-forward") throw new Error("Select a supported merge method.");
  if (stackNumber !== undefined) {
    const request = { ...ref, stackNumber, method, expectedHeads: [...(input.expectedStackHeads ?? [])] };
    if (action === "enable-auto-merge") await api.prEnableStackAutoMerge(request);
    else await api.prMergeStack(request);
    return;
  }
  if (pr.capabilities.actions.includes("merge-stack") && await api.prGetStack(ref))
    throw new Error("Open the stack controls to merge this pull request.");
  if (!expectedHeadSha) throw new Error("Refresh the pull request before merging.");
  if (action === "enable-auto-merge") await api.prEnableAutoMerge(ref, method, expectedHeadSha);
  else {
    const result = await api.prMerge(ref, method, expectedHeadSha);
    if (!result.merged) throw new Error(result.message ?? "The code host refused the merge.");
    return result.detail;
  }
};

export const runPrAction = prCommand("pullRequests.runAction", writePrAction, (reply) => reply);

export const editPr = prCommand<PullRequestUpdateInput, PullRequest>(
  "pullRequests.update",
  ({ api, ref }, i) => {
    if (i.maintainerCanModify !== undefined)
      throw new Error("This host cannot change maintainer access.");
    return api.prUpdate(ref, { title: i.title, body: i.body });
  },
  (reply) => reply,
);
export const labelPr = prCommand<PullRequestLabelChangeInput>(
  "pullRequests.setLabels",
  ({ api, ref, pr }, i) => {
    const names = new Set(pr.labels.map((l) => l.name));
    for (const label of i.labels) {
      if (i.applied) names.add(label);
      else names.delete(label);
    }
    return api.prSetLabels(ref, [...names]);
  },
);
export const requestPrReviewers = prCommand<PullRequestReviewerRequestInput>(
  "pullRequests.requestReviewers",
  async ({ api, ref }, i) => {
    if (i.requested) {
      if (i.reviewers.some((r) => r.kind === "team"))
        throw new Error("This host can request reviews from individual users.");
      await api.prRequestReviewers(
        ref,
        i.reviewers.map((r) => r.id),
      );
    } else
      for (const reviewer of i.reviewers)
        await api.prRemoveRequestedReviewer(ref, reviewer.id, reviewer.kind);
  },
);
export const commentPr = prCommand<PullRequestRef & { body: string }>(
  "pullRequests.comment",
  ({ api, ref }, i) => api.prAddIssueComment(ref, i.body),
);
function anchor(p: PullRequestReviewPosition) {
  return p.kind === "deleted" || (p.kind === "context" && p.side === "left")
    ? { line: p.oldLine, side: "LEFT" as const }
    : { line: p.newLine, side: "RIGHT" as const };
}
export const reviewPr = prCommand<PullRequestSubmitReviewInput & { headSha: string }>(
  "pullRequests.submitReview",
  async ({ api, ctx, ref, pr }, i) => {
    if (pr.headSha !== i.headSha)
      throw new Error("The pull request changed. Refresh the diff before submitting.");
    await api.prSubmitReview(
      ref,
      {
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
      },
      ctx,
    );
  },
);
