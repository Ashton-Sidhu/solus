import type { SessionFolder } from "@solus/contracts/codebases";
import {
  conversationContext,
  DEFAULT_RUN_SETTINGS,
  runProjectRoot,
  sessionFolderContext,
  type ConversationRun,
} from "@solus-mobile/features/conversation/lib/ipc-context";
import { expect, it } from "vite-plus/test";
import { checkoutGitTarget } from "./checkout-git";
import { toThreadShell } from "./session";

const TASK_FOLDER = "/data/solus-task-folders/fix-login-1a2b3c4d";

function run(change: Partial<ConversationRun> = {}): ConversationRun {
  return {
    sessionId: "session-1",
    agentSessionId: "session-1",
    provider: "claude-code",
    status: "idle",
    workingDirectory: "/code/shop/web",
    preferredModel: null,
    reasoningEffort: "high",
    contextWindow: null,
    fastMode: false,
    permissionMode: "supervised",
    title: null,
    organizationId: null,
    ...change,
  };
}

const context = (change: Partial<ConversationRun> = {}) =>
  conversationContext(run(change), DEFAULT_RUN_SETTINGS, {});

it("sends the project root of the record for a session in a task folder", () => {
  // The path of a task folder names no project: the record does.
  const session = context({
    workingDirectory: `${TASK_FOLDER}/shop/web`,
    projectRoot: "/code/shop/web",
  }).session;
  expect(session.workingDirectory).toBe(`${TASK_FOLDER}/shop/web`);
  expect(session.projectPath).toBe("/code/shop/web");
  // A record with no root leaves the path as the only name.
  expect(context({ workingDirectory: `${TASK_FOLDER}/shop/web` }).session.projectPath).toBe(
    `${TASK_FOLDER}/shop/web`,
  );
});

it("keeps the repository as the project of a worktree inside its repository", () => {
  const worktree = "/code/shop/web/.git/solus/worktrees/fix-login";
  // The root of a record is used only for a task folder, where the path cannot name the project.
  expect(runProjectRoot({ workingDirectory: worktree, projectRoot: "/somewhere/else" })).toBe(
    "/code/shop/web",
  );
  expect(context().session.projectPath).toBe("/code/shop/web");
});

it("sends the codebase with each prompt, and the repository choice only with a new worktree", () => {
  const chosen = ["/code/shop/api"];
  expect(context().session).toMatchObject({ codebaseId: null, worktreeRepositories: null });
  // A session in the project's checkout makes no worktree, so the host gets no repository choice.
  expect(context({ codebaseId: "shop", worktreeRepositories: chosen }).session).toMatchObject({
    codebaseId: "shop",
    worktreeBaseBranch: null,
    worktreeRepositories: null,
  });
  expect(
    context({ codebaseId: "shop", worktreeBaseBranch: "main", worktreeRepositories: chosen })
      .session,
  ).toMatchObject({ codebaseId: "shop", worktreeBaseBranch: "main", worktreeRepositories: chosen });
  // No choice: null, and the host applies its default.
  expect(
    context({ codebaseId: "shop", worktreeBaseBranch: "main" }).session.worktreeRepositories,
  ).toBeNull();
});

const api: SessionFolder = {
  path: `${TASK_FOLDER}/shop/api`,
  name: "api",
  state: "git",
  repositoryPath: "/code/shop/api",
  source: "codebase",
  granted: true,
};

it("aims a Git action at a session folder, with the session id of the thread", () => {
  const thread = context({
    workingDirectory: `${TASK_FOLDER}/shop/web`,
    projectRoot: "/code/shop/web",
  });
  const folder = sessionFolderContext(thread, api);
  expect(folder.session).toMatchObject({
    sessionId: "session-1",
    // The folder is the working directory of the call, so the host reads the folder's own checkout.
    workingDirectory: `${TASK_FOLDER}/shop/api`,
    projectPath: "/code/shop/api",
    gitContext: null,
  });
  // The context of the thread does not change.
  expect(thread.session.workingDirectory).toBe(`${TASK_FOLDER}/shop/web`);
});

it("finds the session folder that a Git sheet's route names", () => {
  const cwd = `${TASK_FOLDER}/shop/web`;
  // No repository in the route, or the thread's own folder: the sheet acts on the working directory.
  expect(checkoutGitTarget(cwd, [api], {})).toEqual({
    cwd,
    repository: undefined,
    folder: undefined,
  });
  expect(checkoutGitTarget(cwd, [api], { repositoryCwd: cwd }).repository).toBeUndefined();
  expect(checkoutGitTarget(cwd, [api], { repositoryCwd: api.path, repositoryName: "api" })).toEqual(
    {
      cwd: api.path,
      repository: { key: api.path, cwd: api.path, name: "api" },
      folder: api,
    },
  );
  // A repository that is not a session folder gets no folder, so the sheet gives it no Git action.
  expect(checkoutGitTarget(cwd, [api], { repositoryCwd: "/code/pinned" }).folder).toBeUndefined();
});

it("groups a session in a task folder under its project", () => {
  // The working directory is in the task folder, which is no project of the host.
  const shell = toThreadShell("host", {
    sessionId: "session-1",
    provider: "claude-code",
    projectPath: "-data-solus-task-folders-fix-login-1a2b3c4d-shop-web",
    model: null,
    title: "Fix login",
    customTitle: null,
    createdAt: 1000,
    lastActivityAt: 2000,
    branch: "fix-login",
    cwd: `${TASK_FOLDER}/shop/web`,
    isWorktree: true,
    status: "idle",
    projectRoot: "/code/shop/web",
  });
  expect(shell.projectId).toBe("/code/shop/web");
  expect(shell.worktreePath).toBe(`${TASK_FOLDER}/shop/web`);
});
