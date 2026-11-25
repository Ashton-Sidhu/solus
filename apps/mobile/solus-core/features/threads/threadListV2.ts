import type { SessionExecution } from "@solus/contracts/session-execution";
import type { AgentActivity } from "@solus/contracts/agent-activity";
import { hostPathBaseName, isAbsoluteHostPath } from "@solus/contracts/host-path";
import type { SessionPullRequestLink, SessionPullRequestWatchOutcome } from "@solus/contracts/session-pull-requests";
import type { SessionState, SessionView } from "@solus/contracts/session-state";
import { worktreeProjectRoot, type PinnedSession, type SessionPlace, type SessionRecord, type SessionStatus } from "@solus/contracts/types";
import type { SolusThreadShell } from "./thread-directory";

/** The status of a Solus session as shown in the T3 thread list. */
export type ThreadListV2Status =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

/** The name a session is listed under. */
export function threadTitle(record: Pick<SessionRecord, "customTitle" | "title" | "slug">): string {
  return record.customTitle || record.title || record.slug || "Untitled session";
}

/**
 * The live status wins: the record only knows running or not. A session the
 * host has said nothing about since this client connected reads from its
 * record.
 */
export function resolveThreadListV2Status(
  record: Pick<SessionRecord, "status" | "hasPendingQuestion">,
  liveStatus: SessionStatus | undefined,
  // A live status carries its own question fact; with none, the record's answers.
  hasPendingQuestion = liveStatus === undefined && record.hasPendingQuestion === true,
): ThreadListV2Status {
  // A question that does not block the turn still waits on the person,
  // whether the run still works or has finished. A plan to approve says more.
  if (hasPendingQuestion && liveStatus !== "awaiting_plan") return "input";
  switch (liveStatus) {
    case "awaiting_plan":
      return "approval";
    case "awaiting_input":
      return "input";
    case "connecting":
    case "running":
      return "working";
    case "background":
      return "waiting";
    case "failed":
    case "dead":
      return "failed";
    case "rate_limited":
      return "limited";
    case "idle":
    case "completed":
    case "interrupted":
      return "ready";
    case undefined:
      return record.status === "running" ? "working" : "ready";
  }
}

/* ─── Projects ───────────────────────────────────────────────────────── */

/** `SolusProjectShell.key` for the project a session belongs to: its git
    root when the host lists that root as a project, else its project path. */
/**
 * The folder a session's project is rooted at. A Claude session's
 * `projectPath` is the provider's encoded storage folder ("-Users-me-solus"),
 * not a path, so the project is read from its root, then from the folder it
 * ran in; the stored name is the last resort.
 */
export function threadProjectPath(record: {
  readonly projectPath: string;
  readonly cwd?: string | null;
  readonly projectRoot?: string | null;
}): string {
  return record.projectRoot || (record.cwd ? worktreeProjectRoot(record.cwd) : "") || record.projectPath;
}

export function threadProjectKey(
  thread: SolusThreadShell,
  projectKeys: ReadonlySet<string>,
): string {
  const rootKey = `${thread.hostId}\u0000${threadProjectPath(thread.record)}`;
  if (projectKeys.has(rootKey)) return rootKey;
  return `${thread.hostId}\u0000${thread.record.projectPath}`;
}

export function isChatSession(record: { readonly place?: SessionPlace | null }): boolean {
  return record.place === "chat";
}

/** The folder whose favicon a thread row shows: the listed project's, else the
    session's own project root, so a project the host does not list (a removed
    project, a dispatch checkout) still shows its mark. A chat has none. */
export function threadFaviconRoot(
  record: { readonly projectPath: string; readonly cwd?: string | null; readonly projectRoot?: string | null; readonly place?: SessionPlace | null },
  listedProjectPath: string | null,
): string | null {
  if (listedProjectPath) return listedProjectPath;
  if (isChatSession(record)) return null;
  const path = threadProjectPath(record);
  return isAbsoluteHostPath(path) ? path : null;
}

/** The project label for a session whose project the host does not list. */
export function threadProjectFallbackTitle(record: SessionRecord): string {
  if (isChatSession(record)) return "Chat";
  const path = threadProjectPath(record);
  return hostPathBaseName(path) || path;
}

/** Why the host did not start a watch, or null when the request is done. */
export function watchRefusalMessage(outcome: SessionPullRequestWatchOutcome): string | null {
  switch (outcome) {
    case "started":
    case "already-watching":
    case "stopped":
      return null;
    case "session-settled":
      return "This thread is settled. Un-settle it to watch its pull request.";
    case "not-linked":
      return "This pull request is no longer linked to the thread.";
    case "missing":
      return "The code host no longer has this pull request.";
    case "merged":
    case "closed":
      return `This pull request is ${outcome}, so there is nothing to watch.`;
  }
}

/** What the list knows about every session beyond its record. */
export interface ThreadListV2Facts {
  readonly attention?: ReadonlyMap<string, import("@solus/contracts/attention-types").AttentionEntry>;
  readonly pins?: ReadonlyMap<string, PinnedSession>;
  /** Shared `SessionState` by thread key, as the host announced or answered
      it after the record was read. It overrides the record's state. */
  readonly states: ReadonlyMap<string, SessionState>;
  /** This person's `SessionView` by thread key, as the host announced or
      answered it after the record was read. It overrides the record's view. */
  readonly views: ReadonlyMap<string, SessionView>;
  /** Latest execution event and its presentation facts, by thread key. */
  readonly executions?: ReadonlyMap<string, SessionExecution>;
  readonly liveStatus: ReadonlyMap<string, SessionStatus>;
  /** Thread keys whose last live status said a question waits on the person. */
  readonly pendingQuestions?: ReadonlySet<string>;
  /** Thread keys whose last live status waits on a permission request, not a question. */
  readonly awaitingApprovals?: ReadonlySet<string>;
  /** What the agent does now in a running turn, by thread key. Live only. */
  readonly agentActivity?: ReadonlyMap<string, AgentActivity>;
  /** When the live status began, by thread key: the host's time of the
      change into it. */
  readonly statusSince?: ReadonlyMap<string, number>;
  readonly viewedAt?: ReadonlyMap<string, number | null>;
  /** Read state announced by each host, by thread key. */
  readonly unread?: ReadonlyMap<string, boolean>;
  /** Pull request links by thread key, read again after the record. */
  readonly pullRequests: ReadonlyMap<string, ReadonlyArray<SessionPullRequestLink>>;
}
