import type { SolusThreadShell } from "@solus-mobile/features/threads/thread-directory";
import {
  threadProjectPath,
  threadFaviconRoot,
  type ThreadListV2Facts,
} from "@solus-mobile/features/threads/threadListV2";
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
        Pick<ThreadListV2Facts, "attention" | "liveStatus" | "pendingQuestions" | "statusSince" | "viewedAt" | "pullRequests">
      >,
    automationNames?: ReadonlyMap<string, ReadonlyMap<string, string>>,
    projectsByHost?: ReadonlyMap<string, ReadonlySet<string>>,
    changedPositions?: readonly number[],
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
      const live = facts.liveStatus?.get(key);
      const attention = facts.attention?.get(key);
      const liveStatus = live === "awaiting_input" && attention?.kind === "needs_approval"
        ? "awaiting_plan"
        : live ?? (attention && attentionStatus[attention.kind]);
      const since = facts.statusSince?.get(key) ?? attention?.since;
      const pendingQuestion = live === undefined
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
      cache.set(record, {
        hostId,
        view,
        state,
        pinnedAt,
        automationName,
        hostLinks,
        liveStatus,
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
