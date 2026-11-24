import { expect, it } from "vite-plus/test";
import { resolveQuickAction } from "@t3tools/client-runtime/state/vcs";
import type { GitRepositoryStatus, GitState } from "@solus/contracts/git-types";
import { checkoutActions, checkoutBranch, checkoutStatus } from "./checkout-git";

const repo: GitRepositoryStatus = {
  isRepository: true,
  hasCommits: true,
  branch: "feature",
  primaryRemoteName: "origin",
  primaryRemoteUrl: "git@example.com:team/repo.git",
};

const checkout: GitState = {
  repoRoot: "/repo",
  branch: "feature",
  targetBranch: "main",
  headSha: "abc",
  uncommittedChanges: {
    files: [{ path: "hello.ts", conflicted: false }],
    fileCount: 1,
    hasMoreFiles: false,
    mergeInProgress: false,
  },
  aheadCount: 1,
  behindCount: 0,
  upstreamRef: "origin/feature",
};

it("uses the checkout's branch and open pull request to choose the Git menu action", () => {
  const status = checkoutStatus(repo, {
    ...checkout,
    prUrl: "https://github.com/team/repo/pull/14",
  });
  expect(status.pr?.number).toBe(14);
  const quick = resolveQuickAction(status, false, status.isDefaultRef, status.hasPrimaryRemote);
  expect(quick.action).toBe("commit_push");
  expect(checkoutActions[quick.action!]).toBe("commit_push");
  const fresh = checkoutStatus(repo, checkout);
  const first = resolveQuickAction(fresh, false, fresh.isDefaultRef, fresh.hasPrimaryRemote);
  expect(checkoutActions[first.action!]).toBe("commit_push_pull_request");
});

it("keeps the current branch visible before the first commit", () => {
  const status = checkoutStatus({ ...repo, hasCommits: false, branch: "main" }, null);
  expect(status.isRepo).toBe(true);
  expect(status.refName).toBe("main");
});

it("shows a detached HEAD only after Git confirms a repository with no checked-out branch", () => {
  expect(checkoutBranch(undefined)).toEqual({ kind: "unknown" });
  expect(checkoutBranch({ isRepo: false, refName: null })).toEqual({ kind: "no-repository" });
  expect(checkoutBranch({ isRepo: true, refName: null })).toEqual({ kind: "detached" });
  expect(checkoutBranch({ isRepo: true, refName: repo.branch })).toEqual({ kind: "branch", name: "feature" });
});
