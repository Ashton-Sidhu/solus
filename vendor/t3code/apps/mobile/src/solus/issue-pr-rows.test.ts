import { expect, it } from "vite-plus/test";
import { githubIssueRow, githubPullRequestRow } from "./issue-pr-rows";

const project = { path: "/host/checkout", title: "App" };
it("keeps a GitHub Enterprise issue tied to its repository and distinguishes drafts", () => {
  const task = {
    kind: "issue",
    providerId: "github",
    url: "https://git.example/team/app/issues/42",
    title: "Crash",
    state: { name: "In progress", category: "active" },
    labels: ["bug"],
    updatedAt: 1700000000000,
  } as const;
  const row = githubIssueRow(project, { ...task, labels: [...task.labels] });
  expect(row).toMatchObject({
    projectId: project.path,
    host: "git.example",
    scope: "team/app",
    key: "42",
    displayKey: "#42",
    state: { name: "In progress", category: "open" },
  });
  expect(githubIssueRow(project, { ...task, labels: [], kind: "draft" })).toBeNull();
});
it("keeps the base repo, merge state and review request for a fork PR", () => {
  const row = githubPullRequestRow(project, {
    number: 3,
    url: "https://git.example/team/app/pull/3",
    title: "Fix",
    baseRepo: { host: "git.example", owner: "team", repo: "app" },
    author: "dev",
    authorAvatarUrl: "",
    state: "open",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    draft: false,
    labels: [],
    additions: 3,
    deletions: 1,
    baseRef: "main",
    headRef: "fix",
    mergeable: null,
    reviewAttention: "requested",
  });
  expect(row).toMatchObject({
    projectId: project.path,
    repository: "team/app",
    host: "git.example",
    headBranch: "fix",
    mergeability: "unknown",
    viewerReviewRequested: true,
  });
});
