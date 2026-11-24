import type { SolusThreadShell } from "@solus-mobile/features/threads/thread-directory";
import {
  threadProjectPath,
  threadFaviconRoot,
  type ThreadListV2Facts,
} from "@solus-mobile/features/threads/threadListV2";
import { sessionExecutionStatus } from "@solus/contracts/session-execution";
import type { AgentActivity } from "@solus/contracts/agent-activity";
import type { SessionPlace, SessionStarter, SessionStatus } from "@solus/contracts/types";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { hostPathBaseName } from "@solus/contracts/host-path";
import { sameItems } from "@solus/client-core/keep-equal";
import type { SessionPullRequestLink } from "@solus/contracts/session-pull-requests";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { toThreadShell, type SessionRow } from "./session";

export type SessionListThread = EnvironmentThreadShell & {
  automationName?: string | null;
  fallbackProject?: { title: string; workspaceRoot: string };
  /** The live facts the row's state mark reads (docs/plans/session-state-marks.md). */
  agentActivity?: AgentActivity;
  starting?: true;
  hostAway?: true;
};

const attentionStatus = {
  needs_approval: "awaiting_plan",
  question: "awaiting_input",
  finished: "completed",
  failed: "failed",
} as const;

// A session record contains PR summaries. Branch details arrive when the PR opens.
function sessionPullRequestLinks(links: readonly SessionPullRequestLink[]): ThreadPullRequestLink[] {
  return links.flatMap((link) => {
    if (link.missing) return [];
    const [host, owner, repo] = link.repository.split("/");
    if (!host || !owner || !repo) return [];
    const snapshot = link.snapshot;
    return [{
      host,
      repository: owner + "/" + repo,
      number: link.number,
      url: link.url,
      source: link.source === "branch" ? "agent" : link.source,
      linkedAt: new Date(link.linkedAt).toISOString(),
      stack: null,
      snapshot: snapshot ? {
        title: snapshot.title,
        state: snapshot.state,
        isDraft: snapshot.draft,
        updatedAt: snapshot.updatedAt,
        syncedAt: snapshot.updatedAt,
        headBranch: "",
        baseBranch: "",
      } : null,
    }];
  });
}

export function createSessionListProjection() {
  const cache = new WeakMap<
    SessionRow,
    {
      hostId: string;
      view: SessionRow["view"];
      state: SessionRow["state"];
      pinnedAt: number | undefined;
      automationName: string | null | undefined;
      liveStatus: SessionStatus | undefined;
      agentActivity: AgentActivity | undefined;
      hostAway: boolean;
      pendingQuestion: boolean;
      since: number | undefined;
      viewedAt: number | null;
      projectPath: string;
      hostLinks: readonly SessionPullRequestLink[] | undefined;
      shell: SessionListThread;
    }
  >();
  let previous: SessionListThread[] = [];
  return (
    rows: ReadonlyArray<
      Pick<SolusThreadShell, "hostId" | "key"> & {
        record: SessionRow & { startedBy?: SessionStarter | null; place?: SessionPlace | null };
      }
    >,
    facts: Pick<ThreadListV2Facts, "views" | "states" | "pins"> &
      Partial<
        Pick<
          ThreadListV2Facts,
          | "attention"
          | "liveStatus"
          | "executions"
          | "pendingQuestions"
          | "awaitingApprovals"
          | "agentActivity"
          | "statusSince"
          | "viewedAt"
          | "pullRequests"
        >
      >,
    automationNames?: ReadonlyMap<string, ReadonlyMap<string, string>>,
    projectsByHost?: ReadonlyMap<string, ReadonlySet<string>>,
    changedPositions?: readonly number[],
    /** Hosts past their grace and not ready since: their live states are not current. */
    awayHosts?: ReadonlySet<string>,
  ) => {
    const projectRow = ({ hostId, record, key }: (typeof rows)[number]) => {
      const view = facts.views.get(key) ?? record.view;
      const state = facts.states.get(key) ?? record.state;
      const pinnedAt = facts.pins?.get(key)?.pinnedAt;
      const starter = record.startedBy;
      const automationName =
        starter?.kind === "automation"
          ? (automationNames?.get(hostId)?.get(starter.automationId) ?? null)
          : undefined;
      const root = threadProjectPath(record);
      const hostProjects = projectsByHost?.get(hostId);
      const projectPath =
        hostProjects?.has(record.projectPath) && !hostProjects.has(root)
          ? record.projectPath
          : root;
      const reported = facts.executions?.get(key);
      const saved = record.execution;
      const execution = reported && (!saved || reported.revision >= saved.revision) ? reported : saved;
      const live = execution ? sessionExecutionStatus(execution) : facts.liveStatus?.get(key);
      const attention = facts.attention?.get(key);
      // Mobile rows show a waiting permission and a plan to approve as one Approval.
      const approval = execution ? execution.awaitingApproval === true
        : facts.awaitingApprovals?.has(key) === true || attention?.kind === "needs_approval";
      const liveStatus = live === "awaiting_input" && approval
        ? "awaiting_plan"
        : live ?? (attention && attentionStatus[attention.kind]);
      const agentActivity = facts.agentActivity?.get(key);
      const hostAway = awayHosts?.has(hostId) === true;
      const since = execution?.current?.startedAt ?? execution?.lastTurn?.endedAt ?? facts.statusSince?.get(key) ?? attention?.since;
      // A session this one started that waits on the person shows as Input
      // on this row: mobile rows have one mark for a request.
      const pendingQuestion = execution ? execution.hasPendingQuestion === true || execution.delegatedRequest !== undefined : live === undefined
        ? record.hasPendingQuestion === true
        : facts.pendingQuestions?.has(key) === true;
      const readEvent = facts.viewedAt?.get(key);
      const viewedAt = readEvent === undefined ? (view?.viewedAt ?? null) : readEvent;
      const hostLinks = facts.pullRequests?.get(key) ?? record.pullRequests;
      const held = cache.get(record);
      if (
        held &&
        held.hostId === hostId &&
        held.view === view &&
        held.state === state &&
        held.pinnedAt === pinnedAt &&
        held.automationName === automationName &&
        held.liveStatus === liveStatus &&
        held.agentActivity === agentActivity &&
        held.hostAway === hostAway &&
        held.since === since &&
        held.viewedAt === viewedAt &&
        held.pendingQuestion === pendingQuestion &&
        held.hostLinks === hostLinks &&
        held.projectPath === projectPath
      )
        return held.shell;
      const shell: SessionListThread = toThreadShell(
        hostId,
        record,
        undefined,
        view,
        state,
        pinnedAt,
        {
          pullRequests: held && held.hostLinks === hostLinks
            ? held.shell.source.pullRequests
            : hostLinks && sessionPullRequestLinks(hostLinks),
          projectPath,
          liveStatus,
          since,
          pendingQuestion,
          viewedAt,
        },
      );
      const faviconRoot = threadFaviconRoot(record, null);
      if (faviconRoot) {
        shell.fallbackProject = { title: hostPathBaseName(faviconRoot) || faviconRoot, workspaceRoot: faviconRoot };
      }
      if (automationName !== undefined) shell.automationName = automationName;
      if (agentActivity) shell.agentActivity = agentActivity;
      if (liveStatus === "connecting") shell.starting = true;
      if (hostAway) shell.hostAway = true;
      cache.set(record, {
        hostId,
        view,
        state,
        pinnedAt,
        automationName,
        hostLinks,
        liveStatus,
        agentActivity,
        hostAway,
        since,
        pendingQuestion,
        viewedAt,
        projectPath,
        shell,
      });
      return shell;
    };
    if (changedPositions && previous.length === rows.length) {
      let patched: SessionListThread[] | undefined;
      for (const index of changedPositions) {
        const shell = projectRow(rows[index]!);
        if (shell !== previous[index]) (patched ??= previous.slice())[index] = shell;
      }
      return (previous = patched ?? previous);
    }
    const next = rows.map(projectRow);
    if (!sameItems(previous, next)) previous = next;
    return previous;
  };
}
