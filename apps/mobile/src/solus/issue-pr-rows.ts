// Project IDs in the mobile adapter are host paths. The host reports the repository identity.
import {
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  type IssueListEntry,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import type { PullRequest } from "@solus/contracts/providers";
import type { IssueSummary } from "@solus/contracts/task-types";

export interface ListProject {
  path: string;
  title: string;
}

type IssueFields = Pick<
  IssueSummary,
  | "kind"
  | "providerId"
  | "url"
  | "title"
  | "state"
  | "labels"
  | "assignees"
  | "assignee"
  | "assigneeAvatarUrl"
  | "createdAt"
  | "updatedAt"
>;

export function githubIssueRow(project: ListProject, task: IssueFields): IssueListEntry | null {
  if (task.kind !== "issue" || task.providerId !== "github" || !task.url) return null;
  const url = URL.canParse(task.url) ? new URL(task.url) : null;
  const parts = url?.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/);
  if (!url || !parts) return null;
  const [, owner, repo, key] = parts;
  if (!owner || !repo || !key) return null;
  const assignees =
    task.assignees ??
    (task.assignee ? [{ login: task.assignee, avatarUrl: task.assigneeAvatarUrl }] : []);
  return {
    projectId: ProjectId.make(project.path),
    projectTitle: project.title,
    tracker: IssueTrackerKind.make("github"),
    host: url.host,
    scope: owner + "/" + repo,
    key,
    displayKey: "#" + key,
    title: task.title,
    url: task.url,
    state: { name: task.state.name, category: task.state.category === "done" ? "closed" : "open" },
    createdAt: task.createdAt ? new Date(task.createdAt).toISOString() : "",
    updatedAt: new Date(task.updatedAt).toISOString(),
    closedAt: null,
    author: null,
    assignees: assignees.map((person) => ({
      login: person.login,
      avatarUrl: person.avatarUrl ?? null,
      name: null,
    })),
    labels: task.labels.map((name) => ({ name, color: null })),
    commentCount: 0,
  };
}

type PullRequestFields = Pick<
  PullRequest,
  | "number"
  | "url"
  | "title"
  | "baseRepo"
  | "author"
  | "authorAvatarUrl"
  | "state"
  | "createdAt"
  | "updatedAt"
  | "draft"
  | "labels"
  | "additions"
  | "deletions"
  | "baseRef"
  | "headRef"
  | "mergeable"
  | "reviewAttention"
>;

export function githubPullRequestRow(
  project: ListProject,
  pr: PullRequestFields,
): PullRequestListEntry {
  return {
    projectId: ProjectId.make(project.path),
    projectTitle: project.title,
    provider: SourceControlProviderKind.make("github"),
    repository: pr.baseRepo.owner + "/" + pr.baseRepo.repo,
    host: pr.baseRepo.host,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    author: pr.author
      ? { login: pr.author, name: null, avatarUrl: pr.authorAvatarUrl || null }
      : null,
    state: pr.state,
    isDraft: pr.draft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    labels: pr.labels,
    additions: pr.additions,
    deletions: pr.deletions,
    headBranch: pr.headRef,
    baseBranch: pr.baseRef,
    mergeability: pr.mergeable === null ? "unknown" : pr.mergeable ? "mergeable" : "conflicting",
    viewerReviewRequested: pr.reviewAttention === "requested",
  };
}
