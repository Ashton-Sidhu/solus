import {
  CODEBASE_WORKTREE_DEFAULT_MAX,
  type Codebase,
  type CodebaseMember,
  type SessionFolder,
} from "@solus/contracts/codebases";
import type { DiffRequest, TurnSnapshot } from "@solus/contracts/git-types";
import {
  hostPathKey,
  hostPathSegments,
  isWindowsHostPath,
  sameHostPath,
} from "@solus/contracts/host-path";
import type { SessionChangeSummary } from "@solus/contracts/session-digest";
import {
  threadRepositorySections,
  type PinnedThreadRepository,
  type ThreadRepositorySection,
  type WorktreeRepositoryChoice,
  type WorktreeRepositorySelection,
} from "@t3tools/client-runtime/state/thread-repositories";
import { CheckpointScopeId } from "@t3tools/contracts";
import { msg } from "gt-react-native";
import { m, type MessageResolver } from "../i18n/messages";
import { reviewTurnDiffText } from "../state/reviewTurnDiffs";

/**
 * The rules that give T3's repository screens their Solus data
 * (docs/plans/codebases.md §10): the codebase of a draft, the repositories of
 * a new worktree session, the repository rows of a running session, and the
 * repository groups of a review. Pure: the hooks and screens bind these rules
 * to the codebases model and to the session.
 */

type CodebaseName = Pick<Codebase, "id" | "name">;

export interface DraftCodebase {
  /** The codebases that hold the folder of the project on its host. */
  readonly options: readonly CodebaseName[];
  /** The codebase that the new session starts with. Null: no codebase. */
  readonly codebaseId: string | null;
  /** The codebase that the folder gives with no choice: the only one that holds it. */
  readonly automatic: string | null;
  /** More than one codebase holds the folder, and the person did not choose. */
  readonly needsChoice: boolean;
}

/**
 * The codebase of a new session. A folder in exactly one codebase gets that
 * codebase. A folder in more than one gets the codebase that the person
 * chooses, and "No codebase" is one of the choices. A folder in no codebase
 * gets none.
 */
export function draftCodebase(input: {
  readonly codebases: readonly CodebaseName[];
  /** The person chose, "No codebase" included. */
  readonly isPicked: boolean;
  /** The choice of the person, or the codebase that the run has now. */
  readonly codebaseId: string | null;
}): DraftCodebase {
  const { codebases } = input;
  const automatic = codebases.length === 1 ? codebases[0]!.id : null;
  const isValidPick =
    input.isPicked &&
    (input.codebaseId === null || codebases.some((codebase) => codebase.id === input.codebaseId));
  return {
    options: codebases,
    codebaseId: isValidPick ? input.codebaseId : automatic,
    automatic,
    needsChoice: codebases.length > 1 && !isValidPick,
  };
}

/** A repository of the codebase that a new worktree session can take, or the reason that it cannot. */
export interface WorktreeRepositoryOption extends WorktreeRepositoryChoice {
  /** A submodule follows its parent repository. A repository with no commit cannot get a worktree. */
  readonly unavailable?: "submodule" | "no-commit";
}

export interface WorktreeRepositoryOptions {
  /** The folder of the project is a repository: it gets a worktree itself, and it counts in the default limit. */
  readonly workingIsRepository: boolean;
  /** The `git` members of the codebase on the host besides the folder of the project, in the order of the host. */
  readonly options: readonly WorktreeRepositoryOption[];
}

function relativeFolderPath(from: string, to: string): string | null {
  if (isWindowsHostPath(from) !== isWindowsHostPath(to)) return null;
  const source = hostPathSegments(hostPathKey(from));
  const target = hostPathSegments(hostPathKey(to));
  const targetNames = hostPathSegments(to);
  if (isWindowsHostPath(from) && source[0] !== target[0]) return null;
  let shared = 0;
  while (shared < source.length && shared < target.length && source[shared] === target[shared]) {
    shared += 1;
  }
  return [...source.slice(shared).map(() => ".."), ...targetNames.slice(shared)].join("/");
}

/**
 * The repositories that the upstream checklist of a new worktree thread
 * shows. Null when the folder of the project is not a member of the codebase:
 * the host then makes one worktree inside the repository, and no task folder.
 */
export function worktreeRepositoryOptions(
  members: readonly CodebaseMember[],
  workingDirectory: string,
): WorktreeRepositoryOptions | null {
  const working = members.find(
    (member) => member.state !== "missing" && sameHostPath(member.path, workingDirectory),
  );
  if (!working) return null;
  return {
    workingIsRepository: working.state === "git",
    options: members.flatMap((member): WorktreeRepositoryOption[] => {
      if (member.state !== "git" || sameHostPath(member.path, working.path)) return [];
      const relativePath = relativeFolderPath(working.path, member.path);
      // A different Windows drive shares no folder with the folder of the project: one task folder cannot hold both.
      if (relativePath === null) return [];
      const named: WorktreeRepositoryOption = { repositoryPath: member.path, name: member.name };
      // T3's row shows the folder from the project folder only when the folder is inside it.
      const isInside =
        relativePath !== "" && relativePath !== ".." && !relativePath.startsWith("../");
      const placed: WorktreeRepositoryOption = isInside ? { ...named, relativePath } : named;
      if (member.submodule) return [{ ...placed, unavailable: "submodule" }];
      return [member.hasCommit ? placed : { ...placed, unavailable: "no-commit" }];
    }),
  };
}

export interface WorktreeRepositoryRunSelection extends WorktreeRepositorySelection {
  /** What the run sends as `worktreeRepositories`. Null until the person chooses: the host then applies its default. */
  readonly runRepositories: readonly string[] | null;
}

/**
 * Which repositories a new worktree session takes. With no choice it gives
 * the default of the host (`planTaskFolder`): each repository that can get a
 * worktree when there are at most `CODEBASE_WORKTREE_DEFAULT_MAX`, the folder
 * of the project counted when it is a repository; none above that.
 */
export function resolveWorktreeRepositories(
  input: {
    /** Null while the members load, or when the folder of the project is not a member. */
    readonly repositories: WorktreeRepositoryOptions | null;
    readonly chosen: readonly string[] | null;
  },
  resolve: MessageResolver = m,
): WorktreeRepositoryRunSelection {
  const { repositories, chosen } = input;
  if (repositories === null) {
    return {
      selected: chosen ?? [],
      label: resolve(msg("Repositories")),
      needsChoice: false,
      strategyRepositories: chosen?.map((path) => ({ path })),
      runRepositories: chosen,
    };
  }
  const available = repositories.options.filter((option) => option.unavailable === undefined);
  const takesAllByDefault =
    available.length + (repositories.workingIsRepository ? 1 : 0) <= CODEBASE_WORKTREE_DEFAULT_MAX;
  const wanted = chosen === null ? null : new Set(chosen.map(hostPathKey));
  const selected = available.flatMap((option) =>
    (wanted === null ? takesAllByDefault : wanted.has(hostPathKey(option.repositoryPath)))
      ? [option.repositoryPath]
      : [],
  );
  const needsChoice = chosen === null && !takesAllByDefault && available.length > 0;
  return {
    selected,
    label: needsChoice
      ? resolve(msg("Choose repositories"))
      : selected.length === 0
        ? resolve(msg("No repositories"))
        : selected.length !== 1 && selected.length === available.length
          ? resolve(msg("All repositories"))
          : resolve(
              msg("{count, plural, one {{count} repository} other {{count} repositories}}", {
                count: selected.length,
              }),
            ),
    needsChoice,
    strategyRepositories: chosen === null ? undefined : selected.map((path) => ({ path })),
    runRepositories: chosen === null ? null : selected,
  };
}

/** The mark of a session folder in its row. `worktree`: the session's own worktree of the repository in a task folder. */
export type SessionFolderMark = "worktree" | "attached" | "created" | "observed";

export function sessionFolderMark(folder: SessionFolder): SessionFolderMark | null {
  if (!sameHostPath(folder.path, folder.repositoryPath)) return "worktree";
  // A member of the codebase is a folder of the work: no mark.
  return folder.source === "codebase" ? null : folder.source;
}

export function sessionFolderMarkText(
  mark: SessionFolderMark,
  resolve: MessageResolver = m,
): string {
  switch (mark) {
    case "worktree":
      return resolve(
        msg("Worktree", {
          $context:
            "mark of a repository row: the session works in its own worktree of the repository",
        }),
      );
    case "attached":
      return resolve(
        msg("Attached", {
          $context: "mark of a repository row: a folder that was attached to the session",
        }),
      );
    case "created":
      return resolve(
        msg("Created", { $context: "mark of a repository row: a folder that the session made" }),
      );
    case "observed":
      return resolve(
        msg("Not attached", {
          $context:
            "mark of a repository row: the session changed the folder, but the agent was not given the folder",
        }),
      );
  }
}

/** What a person can do with one session folder, besides its Git actions. */
export interface SessionFolderActions {
  /** A folder with no repository gets one (`gitInitRepository`). */
  readonly tracksWithGit: boolean;
  /** The agent was not given the folder: Solus only shows it. An attach gives it. */
  readonly attaches: boolean;
  /** A person or the agent attached the folder: it can leave the session. */
  readonly detaches: boolean;
}

export function sessionFolderActions(folder: SessionFolder): SessionFolderActions {
  return {
    tracksWithGit: folder.state === "plain",
    attaches: !folder.granted,
    detaches: folder.granted && folder.source === "attached",
  };
}

/** One repository row of a session: T3's section, with the session folder that it shows. Null for a pin. */
export interface SessionRepositorySection extends ThreadRepositorySection {
  readonly folder: SessionFolder | null;
}

export interface SessionRepositorySections {
  readonly visible: readonly SessionRepositorySection[];
  readonly hidden: readonly SessionRepositorySection[];
}

/**
 * The repository rows of a session, through T3's section rule: the pins
 * first, then the session folders in the order of the host, and the rows
 * after the visible few folded away. A row is one session folder at its own
 * path, so its Git state and its Git actions are those of that folder. A
 * session in a task folder shows no pin: a pin would be the checkout of the
 * original, which is not the session's.
 */
export function sessionRepositorySections(input: {
  readonly folders: readonly SessionFolder[];
  readonly pinned: readonly PinnedThreadRepository[];
  readonly threadCwd: string | null;
  readonly showAll: boolean;
  readonly worksInTaskFolder: boolean;
}): SessionRepositorySections {
  const folderByKey = new Map(input.folders.map((folder) => [folder.path, folder]));
  const sections = threadRepositorySections({
    changed: input.folders.map((folder) => ({
      scopeId: CheckpointScopeId.make(folder.path),
      name: folder.name,
      repositoryPath: folder.path,
      cwd: folder.path,
    })),
    pinned: input.worksInTaskFolder ? [] : input.pinned,
    threadCwd: input.threadCwd,
    showAll: input.showAll,
  });
  const withFolder = (section: ThreadRepositorySection): SessionRepositorySection => ({
    ...section,
    folder: section.origin === "pinned" ? null : (folderByKey.get(section.key) ?? null),
  });
  return { visible: sections.visible.map(withFolder), hidden: sections.hidden.map(withFolder) };
}

/** The repositories that "Other repositories" offers in a task folder session: the host's own answer, as T3 rows. */
export function addableWorktreeRepositories(
  candidates: readonly CodebaseMember[],
): PinnedThreadRepository[] {
  return candidates.map((member) => ({ repositoryPath: member.path, name: member.name }));
}

/** The `git` members of the session's codebase that a session outside a task folder can pin: not its own folder, not a row yet. */
export function pinnableRepositories(input: {
  readonly members: readonly Pick<CodebaseMember, "path" | "name" | "state">[];
  readonly sections: SessionRepositorySections;
  readonly threadCwd: string | null;
}): PinnedThreadRepository[] {
  const shown = new Set(
    [...input.sections.visible, ...input.sections.hidden].map((section) =>
      hostPathKey(section.key),
    ),
  );
  return input.members.flatMap((member) =>
    member.state !== "git" ||
    (input.threadCwd !== null && sameHostPath(member.path, input.threadCwd)) ||
    shown.has(hostPathKey(member.path))
      ? []
      : [{ repositoryPath: member.path, name: member.name }],
  );
}

/** The key of the session's own checkout in a review. */
export const REVIEW_ROOT_REPOSITORY = ".";

/** One repository of a review: T3's group, with the path that names it in a diff read. */
export interface ReviewRepository {
  /** `REVIEW_ROOT_REPOSITORY` for the session's own checkout, else the `repositoryPath` of the session folder. */
  readonly key: string;
  readonly name: string;
  /** The folder from the working directory, `/`-separated. Empty for the session's own checkout. It can start with `../`. */
  readonly relativePath: string;
  /** What a diff read sends as `repositoryPath`. Undefined: the checkout of the context. */
  readonly repositoryPath: string | undefined;
}

/**
 * The repositories of a session's review: its own checkout first, then each
 * `git` session folder. The repositories that the change summary names come
 * first, in its order, with its names. Two folders of one repository are one
 * repository: the first one, as on the host. Empty for a session with no
 * `git` session folder: its review reads one checkout, as before.
 */
export function reviewRepositories(input: {
  readonly workingDirectory: string;
  readonly rootName: string;
  readonly folders: readonly SessionFolder[];
  /** `SessionChangeSummary.repositories`: present only when more than one repository has changes. */
  readonly summary: Pick<SessionChangeSummary, "repositories"> | null;
}): ReviewRepository[] {
  const byRepository = new Map<string, SessionFolder>();
  for (const folder of input.folders) {
    if (folder.state !== "git") continue;
    const key = hostPathKey(folder.repositoryPath);
    if (!byRepository.has(key)) byRepository.set(key, folder);
  }
  if (byRepository.size === 0) return [];
  const changed = input.summary?.repositories ?? [];
  const changedNames = new Map(
    changed.map((repository) => [hostPathKey(repository.repositoryPath), repository.name]),
  );
  const ordered = [
    ...changed.flatMap((repository) => {
      const folder = byRepository.get(hostPathKey(repository.repositoryPath));
      return folder ? [folder] : [];
    }),
    ...[...byRepository.values()].filter(
      (folder) => !changedNames.has(hostPathKey(folder.repositoryPath)),
    ),
  ];
  return [
    {
      key: REVIEW_ROOT_REPOSITORY,
      name: input.rootName,
      relativePath: "",
      repositoryPath: undefined,
    },
    ...ordered.flatMap((folder): ReviewRepository[] => {
      const relativePath = relativeFolderPath(input.workingDirectory, folder.path);
      // A folder with no path from the working directory (a different Windows drive) has no place in the one patch.
      if (!relativePath) return [];
      return [
        {
          key: folder.repositoryPath,
          name: changedNames.get(hostPathKey(folder.repositoryPath)) ?? folder.name,
          relativePath,
          repositoryPath: folder.path,
        },
      ];
    }),
  ];
}

/** One turn of a review, over the repositories that it changed. */
export interface ReviewTurn {
  /** The trace of the turn. A snapshot with no trace stands alone, by its repository and its index. */
  readonly id: string;
  readonly timestamp: number;
  readonly userMessagePreview: string;
  /** The index of the turn's snapshot in each repository that has one, by `ReviewRepository.key`. */
  readonly indexes: Readonly<{ [repositoryKey: string]: number }>;
}

/**
 * The turns of a session over its repositories, newest first. Each
 * repository counts its own snapshots, so one turn has a different index in
 * each: the snapshots of one turn join by `traceId`, never by index
 * (docs/plans/codebases.md §8).
 */
export function joinTurnsByTrace(
  repositories: readonly {
    readonly key: string;
    readonly snapshots: readonly Pick<
      TurnSnapshot,
      "index" | "timestamp" | "userMessagePreview" | "traceId"
    >[];
  }[],
): ReviewTurn[] {
  const turns = new Map<
    string,
    {
      id: string;
      timestamp: number;
      userMessagePreview: string;
      indexes: { [key: string]: number };
    }
  >();
  for (const repository of repositories) {
    for (const snapshot of repository.snapshots) {
      const id = snapshot.traceId ?? `${repository.key}\u0000${snapshot.index}`;
      const turn = turns.get(id);
      if (!turn) {
        turns.set(id, {
          id,
          timestamp: snapshot.timestamp,
          userMessagePreview: snapshot.userMessagePreview,
          indexes: { [repository.key]: snapshot.index },
        });
        continue;
      }
      turn.indexes[repository.key] = snapshot.index;
      // The turn ended when its last repository was captured.
      turn.timestamp = Math.max(turn.timestamp, snapshot.timestamp);
      turn.userMessagePreview ||= snapshot.userMessagePreview;
    }
  }
  return [...turns.values()].sort((a, b) => b.timestamp - a.timestamp);
}

/** What one section of a review compares: a scope of each repository, or one turn by its index in each repository. */
export type ReviewSectionScope =
  | { readonly kind: "branch" | "working-tree" | "session" }
  | { readonly kind: "turn"; readonly indexes: ReviewTurn["indexes"] };

/** One diff read of a review section: the repository, and the request that the host gets. */
export interface ReviewDiffRead {
  readonly key: string;
  readonly name: string;
  readonly relativePath: string;
  readonly request: DiffRequest;
}

/**
 * The diff reads of one review section: one for each repository, each with
 * its `repositoryPath`. The session's own checkout sends none, so the host
 * reads the checkout of the context. A turn is read only in the repositories
 * that it changed, each at its own index. With no repositories (a session
 * with one checkout), one read of the context's checkout.
 */
export function reviewDiffReads(
  repositories: readonly ReviewRepository[],
  scope: ReviewSectionScope,
): ReviewDiffRead[] {
  const targets: readonly ReviewRepository[] =
    repositories.length > 0
      ? repositories
      : [{ key: REVIEW_ROOT_REPOSITORY, name: "", relativePath: "", repositoryPath: undefined }];
  return targets.flatMap((repository): ReviewDiffRead[] => {
    let request: DiffRequest;
    if (scope.kind === "turn") {
      const index = scope.indexes[repository.key];
      if (index === undefined) return [];
      request = { scope: { kind: "turn", index } };
    } else {
      request = { scope: { kind: scope.kind } };
    }
    if (repository.repositoryPath !== undefined) request.repositoryPath = repository.repositoryPath;
    return [
      {
        key: repository.key,
        name: repository.name,
        relativePath: repository.relativePath,
        request,
      },
    ];
  });
}

/** The one patch that a review section shows, and the repositories that have changes in it. */
export interface ReviewSectionPatch {
  readonly diff: string;
  /** T3's repository groups: present only when more than one repository has changes in the section. */
  readonly groups:
    | readonly { readonly key: string; readonly name: string; readonly relativePath: string }[]
    | undefined;
}

/**
 * The patches of the repositories of one section as the one patch that T3's
 * review shows (`reviewTurnDiffText`): the files of a session folder get the
 * folder's path from the working directory in front, so two repositories
 * never name one file the same, and a review comment names a path that the
 * agent can open. A repository with no answer has no changes.
 */
export function combinedReviewPatch(
  answers: readonly (Pick<ReviewDiffRead, "key" | "name" | "relativePath"> & {
    readonly patch: string | null;
  })[],
): ReviewSectionPatch {
  const changed = answers.filter((answer) => (answer.patch ?? "").trim() !== "");
  const root = changed.find((answer) => answer.relativePath === "");
  const diff = reviewTurnDiffText({
    diff: root?.patch ?? "",
    repositories: changed.flatMap((answer) =>
      answer.relativePath === ""
        ? []
        : [
            {
              name: answer.name,
              repositoryPath: answer.key,
              relativePath: answer.relativePath,
              diff: answer.patch ?? "",
            },
          ],
    ),
  });
  return {
    diff,
    groups:
      changed.length > 1
        ? changed.map(({ key, name, relativePath }) => ({ key, name, relativePath }))
        : undefined,
  };
}
