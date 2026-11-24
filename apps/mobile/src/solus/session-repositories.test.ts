import type { CodebaseMember, SessionFolder } from "@solus/contracts/codebases";
import { expect, it } from "vite-plus/test";
import {
  addableWorktreeRepositories,
  combinedReviewPatch,
  draftCodebase,
  joinTurnsByTrace,
  pinnableRepositories,
  resolveWorktreeRepositories,
  reviewDiffReads,
  reviewRepositories,
  sessionFolderActions,
  sessionFolderMark,
  sessionRepositorySections,
  worktreeRepositoryOptions,
} from "./session-repositories";

const shop = { id: "shop", name: "Shop" };
const platform = { id: "platform", name: "Platform" };

function member(path: string, change: Partial<CodebaseMember> = {}): CodebaseMember {
  return {
    path,
    name: path.split("/").at(-1)!,
    state: "git",
    repositoryKey: null,
    rootPath: "/code/shop",
    discovered: path !== "/code/shop",
    hasCommit: true,
    submodule: false,
    ...change,
  };
}

function folder(path: string, change: Partial<SessionFolder> = {}): SessionFolder {
  return {
    path,
    name: path.split("/").at(-1)!,
    state: "git",
    repositoryPath: path,
    source: "codebase",
    granted: true,
    ...change,
  };
}

it("starts a draft with no codebase when no codebase holds its folder", () => {
  expect(draftCodebase({ codebases: [], isPicked: false, codebaseId: null })).toMatchObject({
    codebaseId: null,
    automatic: null,
    needsChoice: false,
  });
});

it("gives a draft the one codebase that holds its folder", () => {
  expect(draftCodebase({ codebases: [shop], isPicked: false, codebaseId: null })).toMatchObject({
    codebaseId: "shop",
    automatic: "shop",
    needsChoice: false,
  });
});

it("asks the person when two codebases hold the folder, and takes No codebase as a choice", () => {
  const codebases = [shop, platform];
  // No choice yet: the run names no codebase, and the control asks.
  expect(draftCodebase({ codebases, isPicked: false, codebaseId: null })).toMatchObject({
    codebaseId: null,
    automatic: null,
    needsChoice: true,
  });
  expect(draftCodebase({ codebases, isPicked: true, codebaseId: "platform" })).toMatchObject({
    codebaseId: "platform",
    needsChoice: false,
  });
  // "No codebase" is a choice: the control does not ask again.
  expect(draftCodebase({ codebases, isPicked: true, codebaseId: null })).toMatchObject({
    codebaseId: null,
    needsChoice: false,
  });
  // A choice that a delete removed is not a choice.
  expect(draftCodebase({ codebases, isPicked: true, codebaseId: "gone" })).toMatchObject({
    codebaseId: null,
    needsChoice: true,
  });
});

function shopMembers(repositoryCount: number): CodebaseMember[] {
  return [
    member("/code/shop", { state: "plain" }),
    ...Array.from({ length: repositoryCount }, (_, index) => member(`/code/shop/service-${index}`)),
  ];
}

it("takes each repository by default at the limit of eight, the working repository counted", () => {
  // A plain working folder is not a repository: eight others are eight.
  const plain = worktreeRepositoryOptions(shopMembers(8), "/code/shop");
  const all = resolveWorktreeRepositories({ repositories: plain, chosen: null });
  expect(all.selected).toHaveLength(8);
  expect(all.needsChoice).toBe(false);
  // No choice: the run sends null, and the host applies the same default.
  expect(all.runRepositories).toBeNull();

  // A working repository counts: seven others with it are eight, eight others are nine.
  const members = [member("/code/shop"), ...shopMembers(8).slice(1)];
  const nine = worktreeRepositoryOptions(members, "/code/shop");
  expect(nine?.workingIsRepository).toBe(true);
  const none = resolveWorktreeRepositories({ repositories: nine, chosen: null });
  expect(none.selected).toEqual([]);
  expect(none.needsChoice).toBe(true);
  expect(none.runRepositories).toBeNull();
  const eight = resolveWorktreeRepositories({
    repositories: worktreeRepositoryOptions(members.slice(0, 8), "/code/shop"),
    chosen: null,
  });
  expect(eight.selected).toHaveLength(7);
  expect(eight.needsChoice).toBe(false);
});

it("takes no repository by default above the limit", () => {
  const selection = resolveWorktreeRepositories({
    repositories: worktreeRepositoryOptions(shopMembers(9), "/code/shop"),
    chosen: null,
  });
  expect(selection.selected).toEqual([]);
  expect(selection.needsChoice).toBe(true);
});

it("does not let a submodule or a repository with no commit be chosen", () => {
  const repositories = worktreeRepositoryOptions(
    [
      member("/code/shop", { state: "plain" }),
      member("/code/shop/api"),
      member("/code/shop/vendor", { submodule: true }),
      member("/code/shop/empty", { hasCommit: false }),
      member("/code/shop/notes", { state: "plain" }),
      member("/code/libs/ui", { rootPath: "/code/libs/ui", discovered: false }),
    ],
    "/code/shop",
  );
  // The working folder and a plain folder are not choices. A repository outside the working folder has no relative path.
  expect(repositories?.options).toEqual([
    { repositoryPath: "/code/shop/api", name: "api", relativePath: "api" },
    {
      repositoryPath: "/code/shop/vendor",
      name: "vendor",
      relativePath: "vendor",
      unavailable: "submodule",
    },
    {
      repositoryPath: "/code/shop/empty",
      name: "empty",
      relativePath: "empty",
      unavailable: "no-commit",
    },
    { repositoryPath: "/code/libs/ui", name: "ui" },
  ]);
  // The default and a choice both leave them out.
  expect(resolveWorktreeRepositories({ repositories, chosen: null }).selected).toEqual([
    "/code/shop/api",
    "/code/libs/ui",
  ]);
  const chosen = resolveWorktreeRepositories({
    repositories,
    chosen: ["/code/shop/vendor", "/code/shop/empty", "/code/libs/ui"],
  });
  expect(chosen.selected).toEqual(["/code/libs/ui"]);
  // The choice is what the run sends as `worktreeRepositories`.
  expect(chosen.runRepositories).toEqual(["/code/libs/ui"]);
});

it("gives no repository choice when the folder of the project is not a member", () => {
  expect(
    worktreeRepositoryOptions([member("/code/shop/api")], "/code/shop/api/packages/x"),
  ).toBeNull();
  const selection = resolveWorktreeRepositories({ repositories: null, chosen: null });
  expect(selection.runRepositories).toBeNull();
});

const folders: SessionFolder[] = [
  folder("/code/shop/api"),
  folder("/code/notes", { state: "plain", source: "attached" }),
  folder("/code/tools", { source: "created" }),
  folder("/code/other", { source: "observed", granted: false }),
  folder("/data/solus-task-folders/fix-1a2b3c4d/shop/web", { repositoryPath: "/code/shop/web" }),
];

it("makes one repository row for each session folder, at the folder's own path", () => {
  const sections = sessionRepositorySections({
    folders,
    pinned: [],
    threadCwd: "/code/shop",
    showAll: true,
    worksInTaskFolder: false,
  });
  expect(sections.visible.map((section) => [section.name, section.cwd])).toEqual([
    ["api", "/code/shop/api"],
    ["notes", "/code/notes"],
    ["tools", "/code/tools"],
    ["other", "/code/other"],
    // The worktree stands in for its repository: Git reads and actions use the worktree.
    ["web", "/data/solus-task-folders/fix-1a2b3c4d/shop/web"],
  ]);
  expect(
    sections.visible.map((section) => section.folder && sessionFolderMark(section.folder)),
  ).toEqual([null, "attached", "created", "observed", "worktree"]);
});

it("folds the rows after the visible few, and shows a pin only outside a task folder", () => {
  const pinned = [{ repositoryPath: "/code/pinned", name: "pinned" }];
  const folded = sessionRepositorySections({
    folders,
    pinned,
    threadCwd: "/code/shop",
    showAll: false,
    worksInTaskFolder: false,
  });
  expect(folded.visible.map((section) => section.name)).toEqual([
    "pinned",
    "api",
    "notes",
    "tools",
  ]);
  expect(folded.visible[0]).toMatchObject({ origin: "pinned", folder: null });
  expect(folded.hidden.map((section) => section.name)).toEqual(["other", "web"]);
  const inTaskFolder = sessionRepositorySections({
    folders,
    pinned,
    threadCwd: "/code/shop",
    showAll: true,
    worksInTaskFolder: true,
  });
  expect(inTaskFolder.visible.some((section) => section.origin === "pinned")).toBe(false);
});

it("offers Track with Git, Attach, and Detach by the state and the source of the folder", () => {
  expect(folders.map(sessionFolderActions)).toEqual([
    { tracksWithGit: false, attaches: false, detaches: false },
    { tracksWithGit: true, attaches: false, detaches: true },
    { tracksWithGit: false, attaches: false, detaches: false },
    { tracksWithGit: false, attaches: true, detaches: false },
    { tracksWithGit: false, attaches: false, detaches: false },
  ]);
});

it("offers the host's worktree candidates in a task folder, and the unshown members to pin outside one", () => {
  expect(addableWorktreeRepositories([member("/code/shop/docs")])).toEqual([
    { repositoryPath: "/code/shop/docs", name: "docs" },
  ]);
  const sections = sessionRepositorySections({
    folders: [folder("/code/shop/api")],
    pinned: [],
    threadCwd: "/code/shop/web",
    showAll: true,
    worksInTaskFolder: false,
  });
  expect(
    pinnableRepositories({
      members: [
        member("/code/shop", { state: "plain" }),
        member("/code/shop/api"),
        member("/code/shop/web"),
        member("/code/shop/docs"),
      ],
      sections,
      threadCwd: "/code/shop/web",
    }),
  ).toEqual([{ repositoryPath: "/code/shop/docs", name: "docs" }]);
});

const reviewFolders: SessionFolder[] = [
  folder("/code/shop/api"),
  folder("/code/shop/notes", { state: "plain" }),
  folder("/data/solus-task-folders/fix-1a2b3c4d/libs/ui", { repositoryPath: "/code/libs/ui" }),
];

it("gives a review no repository group for a session with one checkout", () => {
  expect(
    reviewRepositories({
      workingDirectory: "/code/shop/web",
      rootName: "web",
      folders: [],
      summary: null,
    }),
  ).toEqual([]);
  // One read of the context's checkout, with no `repositoryPath`.
  expect(reviewDiffReads([], { kind: "session" })).toEqual([
    { key: ".", name: "", relativePath: "", request: { scope: { kind: "session" } } },
  ]);
});

it("groups a review by the session folders when the summary names no repositories", () => {
  const repositories = reviewRepositories({
    workingDirectory: "/code/shop/web",
    rootName: "web",
    folders: reviewFolders,
    summary: {},
  });
  // The session's own checkout first, then each `git` folder. A plain folder has no diff.
  expect(repositories).toEqual([
    { key: ".", name: "web", relativePath: "", repositoryPath: undefined },
    {
      key: "/code/shop/api",
      name: "api",
      relativePath: "../api",
      repositoryPath: "/code/shop/api",
    },
    {
      key: "/code/libs/ui",
      name: "ui",
      relativePath: "../../../data/solus-task-folders/fix-1a2b3c4d/libs/ui",
      repositoryPath: "/data/solus-task-folders/fix-1a2b3c4d/libs/ui",
    },
  ]);
});

it("puts the repositories of the change summary first, with its names, and reads each diff with its repository", () => {
  const repositories = reviewRepositories({
    workingDirectory: "/code/shop/web",
    rootName: "web",
    folders: reviewFolders,
    summary: {
      repositories: [
        {
          repositoryPath: "/code/libs/ui",
          name: "UI library",
          filesChanged: 1,
          additions: 2,
          deletions: 0,
          files: [],
        },
        {
          repositoryPath: "/code/shop/web",
          name: "web",
          filesChanged: 1,
          additions: 1,
          deletions: 1,
          files: [],
        },
      ],
    },
  });
  expect(repositories.map((repository) => [repository.key, repository.name])).toEqual([
    [".", "web"],
    ["/code/libs/ui", "UI library"],
    ["/code/shop/api", "api"],
  ]);
  // The worktree is the path that the diff read names.
  expect(
    reviewDiffReads(repositories, { kind: "working-tree" }).map((read) => read.request),
  ).toEqual([
    { scope: { kind: "working-tree" } },
    {
      scope: { kind: "working-tree" },
      repositoryPath: "/data/solus-task-folders/fix-1a2b3c4d/libs/ui",
    },
    { scope: { kind: "working-tree" }, repositoryPath: "/code/shop/api" },
  ]);
});

it("joins the turns of the repositories by their trace, not by their index", () => {
  const turns = joinTurnsByTrace([
    {
      key: ".",
      snapshots: [
        { index: 0, timestamp: 100, userMessagePreview: "Add the form", traceId: "trace-a" },
        { index: 1, timestamp: 300, userMessagePreview: "Fix the test", traceId: "trace-c" },
      ],
    },
    {
      key: "/code/shop/api",
      snapshots: [
        // The second turn changed only this repository: it is index 0 here.
        { index: 0, timestamp: 200, userMessagePreview: "Add the route", traceId: "trace-b" },
        { index: 1, timestamp: 310, userMessagePreview: "Fix the test", traceId: "trace-c" },
        { index: 2, timestamp: 400, userMessagePreview: "Old snapshot" },
      ],
    },
  ]);
  expect(turns.map((turn) => [turn.id, turn.indexes])).toEqual([
    ["/code/shop/api\u00002", { "/code/shop/api": 2 }],
    ["trace-c", { ".": 1, "/code/shop/api": 1 }],
    ["trace-b", { "/code/shop/api": 0 }],
    ["trace-a", { ".": 0 }],
  ]);
  const repositories = reviewRepositories({
    workingDirectory: "/code/shop/web",
    rootName: "web",
    folders: [folder("/code/shop/api")],
    summary: null,
  });
  // A turn is read only in the repositories that it changed, each at its own index.
  expect(
    reviewDiffReads(repositories, { kind: "turn", indexes: turns[2]!.indexes }).map(
      (read) => read.request,
    ),
  ).toEqual([{ scope: { kind: "turn", index: 0 }, repositoryPath: "/code/shop/api" }]);
  expect(
    reviewDiffReads(repositories, { kind: "turn", indexes: turns[1]!.indexes }).map(
      (read) => read.request,
    ),
  ).toEqual([
    { scope: { kind: "turn", index: 1 } },
    { scope: { kind: "turn", index: 1 }, repositoryPath: "/code/shop/api" },
  ]);
});

const patch = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

it("shows the patches of several repositories as one patch, each file below its folder", () => {
  const combined = combinedReviewPatch([
    { key: ".", name: "web", relativePath: "", patch: patch("src/app.ts") },
    { key: "/code/shop/api", name: "api", relativePath: "../api", patch: patch("src/app.ts") },
    { key: "/code/libs/ui", name: "ui", relativePath: "../../libs/ui", patch: null },
  ]);
  expect(combined.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
  expect(combined.diff).toContain("diff --git a/../api/src/app.ts b/../api/src/app.ts");
  // Only the repositories with changes are groups.
  expect(combined.groups).toEqual([
    { key: ".", name: "web", relativePath: "" },
    { key: "/code/shop/api", name: "api", relativePath: "../api" },
  ]);
  // One repository with changes needs no selector.
  expect(
    combinedReviewPatch([
      { key: ".", name: "web", relativePath: "", patch: "" },
      { key: "/code/shop/api", name: "api", relativePath: "../api", patch: patch("a.ts") },
    ]).groups,
  ).toBeUndefined();
});
