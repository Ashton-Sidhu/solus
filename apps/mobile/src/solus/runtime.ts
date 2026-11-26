import { Atom } from "effect/reactivity";
import { shellDirectorySource } from "./shell-snapshot";
import { createNavigationThreads } from "./navigation-threads";
import { appAtomRegistry } from "../state/atom-registry";
import { mobileHostConnections, fileAccountScope } from "../state/mobile-host";
import { keepEqual } from "@solus/client-core/keep-equal";
import { AppState } from "react-native";
import { useSyncExternalStore } from "react";
import { hostReadinessCopy } from "@solus/client-core/host-readiness";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { PresumedHost, SessionRowChange } from "@solus-mobile/features/threads/thread-directory";
import { readsSessionShell } from "@solus-mobile/features/threads/session-shell";
import { SolusApp } from "@solus-mobile/app/solus-app";
import { holdLaunchSplashForHomeRows } from "../features/home/home-launch-splash";
import { keepStartTrace, markStart, START_TRACE_KEY } from "@solus-mobile/lib/start-trace";
import { expoPlatform, watchAppLifecycle } from "@solus-mobile/platform/expo";
import type { WorkspaceEnvironment } from "../state/workspaceModel";
import { solusWorkspaceState } from "./workspace-state";
import { solusListHosts } from "./list-hosts";
import { createSessionListProjection } from "./session-list";
import { NearbyDiscovery } from "./discovery";
import { installAgentActivity } from "../features/live-activity/install-agent-activity";
import { installSolusAgentAlerts } from "../features/agent-awareness/solusAgentAlerts";
import { createConversationTransport } from "./transport";
import { sessionShellStore } from "./session-shell-store";

export const solus = new SolusApp({
  ...expoPlatform,
  createTransport: createConversationTransport,
  sessionShellStore,
});
export const nearby = new NearbyDiscovery(solus, expoPlatform.storage);
let loaded = false;
let shellCachesRead = false;
const shellCacheRestores = new Map<string, Promise<void> | null>();
export function useSolusShellCachesRead(hostId?: string) {
  return useSyncExternalStore(subscribe, () =>
    hostId === undefined
      ? shellCachesRead
      : loadError !== null || shellCacheRestores.get(hostId) === null,
  );
}
let loadError: string | null = null;
const automationNames = new Map<string, ReadonlyMap<string, string>>();
let automationRevision = 0;
let codebaseRevision = 0;
const rowActions = new Map<string, number>();
export function noteSessionListAction(hostId: string) {
  rowActions.set(hostId, (rowActions.get(hostId) ?? 0) + 1);
  changed();
}
const rowReaders = new Map<string, (event: { sessionId: string }) => void>();
export function refreshSessionRow(hostId: string, sessionId: string) {
  rowReaders.get(hostId)?.({ sessionId });
}
let revision = 0;
let hostsRevision = 0;
function hostsChanged() {
  hostsRevision++;
  changed();
}
const listeners = new Set<() => void>();
function changed() {
  revision++;
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function startSolus() {
  appAtomRegistry.set(shellDirectorySource, solusDirectoryAtom);
  appAtomRegistry.set(mobileHostConnections, solus.connections);
  let active = true;
  let localReady = false;
  let stopAgentAwareness: (() => void) | undefined;
  let scope = "";
  const hosts = new Map<string, () => void>();
  let restoredRowsHeld = false;
  function restoreShellCache(hostId: string, presumed?: PresumedHost) {
    if (shellCacheRestores.has(hostId)) return;
    // `hasHistoryKey` then answers true or false when a session opens.
    void solus.sessionCache.forHost(hostId).readKeys();
    const pending = solus.threads.restore(hostId, presumed);
    shellCacheRestores.set(hostId, pending);
    void pending.finally(() => {
      if (!active || shellCacheRestores.get(hostId) !== pending) return;
      shellCacheRestores.set(hostId, null);
      markStart(`restore_done:${solus.threads.threads().length}`);
      // The saved rows keep the native splash until Home lays them out. This read can end
      // before Home mounts, and Home holds the splash only from its own first rows.
      if (!restoredRowsHeld && solus.threads.threads().length > 0) {
        restoredRowsHeld = true;
        holdLaunchSplashForHomeRows();
      }
      shellCachesRead = [...shellCacheRestores.values()].every(read => read === null);
      changed();
    });
  }
  // The saved lists of the last start show before the account and the hosts are read.
  keepStartTrace((value) => expoPlatform.storage.setItem(START_TRACE_KEY, value));
  const presumedHosts = solus.presumeLastSessionList();
  markStart(`presumed_hosts:${presumedHosts.length}`);
  let presumedScope: string | null = presumedHosts.length ? solus.sessionCache.scope() : null;
  for (const host of presumedHosts) restoreShellCache(host.id, host);
  function refresh() {
    if (loaded) void nearby.scan();
    for (const host of solus.registry.hosts()) {
      // A host that follows its session shell opens it again (`ThreadDirectory.load`).
      if (solus.threads.stateOf(host.id).kind === "error") void solus.threads.load(host.id);
    }
  }
  function reconcile() {
    if (!active || !localReady) return;
    const nextScope = solus.sessionCache.scope();
    solus.confirmLastSessionList();
    if (scope !== nextScope) {
      hosts.forEach(stop => stop());
      hosts.clear();
      // The restores of the last start stay when the account kept its scope.
      if (nextScope !== presumedScope) shellCacheRestores.clear();
      presumedScope = null;
      rowActions.clear();
      scope = nextScope;
      appAtomRegistry.set(fileAccountScope, { key: scope, organizationId: solus.account.organizationId });
    }
    const saved = solus.registry.hosts();
    for (const [id, stop] of hosts) {
      if (!saved.some((host) => host.id === id)) {
        stop();
        hosts.delete(id);
        rowActions.delete(id);
      }
    }
    for (const id of shellCacheRestores.keys()) {
      if (!saved.some(host => host.id === id) && !solus.threads.presumes(id)) shellCacheRestores.delete(id);
    }
    for (const host of saved) {
      restoreShellCache(host.id);
      if (hosts.has(host.id)) continue;
      const connection = solus.connections.connection(host.id);
      if (!connection) continue;
      let generation: number | undefined;
      let automationRequest = 0;
      let lastAutomationRows: ReturnType<typeof solus.threads.threads> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let disposed = false;
      /** The host has the `sessionShell` capability: its list comes from the shell (docs/plans/mobile-session-shell.md §6). */
      let followsShell = false;
      let readingRecords = false;
      const pendingRecords = new Set<string>();
      const deltas = new Map<string, SessionRowChange>();
      const flushRecords = async () => {
        if (followsShell) {
          // The shell sends each row change; the record reads are the older path.
          pendingRecords.clear();
          deltas.clear();
          return;
        }
        if (disposed || readingRecords || (!pendingRecords.size && !deltas.size) ||
            solus.threads.stateOf(host.id).kind !== "loaded" ||
            connection.state.readiness !== "ready") return;
        readingRecords = true;
        const changes = new Map(deltas);
        deltas.clear();
        for (const id of solus.threads.applyRowChanges(host.id, changes)) pendingRecords.add(id);
        const ids = [...pendingRecords];
        pendingRecords.clear();
        try {
          // A large index sweep is cheaper as one snapshot than as individual RPCs.
          if (!ids.length) return;
          if (ids.length > 16) await solus.threads.load(host.id, 0, "sessions");
          else if (!await solus.threads.refreshRecords(host.id, ids)) {
            for (const id of ids) pendingRecords.add(id);
          }
        } catch {
          if (!disposed) await solus.threads.load(host.id, 0, "sessions");
        } finally {
          readingRecords = false;
          if (!disposed && (pendingRecords.size || deltas.size)) scheduleRecords();
        }
      };
      const scheduleRecords = () => {
        if (timer || disposed || (!pendingRecords.size && !deltas.size)) return;
        timer = setTimeout(() => { timer = undefined; void flushRecords(); }, 100);
      };
      const recordChanged = ({sessionId}: {sessionId: string}) => {
        pendingRecords.add(sessionId);
        scheduleRecords();
      };
      rowReaders.set(host.id, recordChanged);
      const receiveAutomationNames = (automations: readonly { id: string; name: string }[]) => {
        automationRevision++;
        automationNames.set(host.id, new Map(automations.map(({ id, name }) => [id, name])));
        changed();
      };
      const refreshAutomationNames = () => {
        if (solus.connections.state(host.id)?.readiness !== "ready") return;
        const request = ++automationRequest;
        void connection.api.automationList().then((automations) => {
          if (request !== automationRequest) return;
          receiveAutomationNames(automations);
        }, () => {
          // Older hosts can still list sessions without answering automation reads.
        });
      };
      const readAutomationNames = () => {
        // The shell's rows carry their automation names.
        if (followsShell || generation === undefined || automationRequest > 0 || connection.state.readiness !== "ready") return;
        const rows = solus.threads.threads();
        if (rows === lastAutomationRows) return;
        const positions = lastAutomationRows && solus.threads.changedPositions(lastAutomationRows, []);
        lastAutomationRows = rows;
        const belongsToAutomation = ({ hostId, record }: (typeof rows)[number]) =>
          hostId === host.id && record.startedBy?.kind === "automation";
        if (positions ? positions.some(index => belongsToAutomation(rows[index]!)) : rows.some(belongsToAutomation)) refreshAutomationNames();
      };
      const followShell = (hasShell: boolean) => {
        if (followsShell === hasShell) return hasShell;
        followsShell = hasShell;
        if (hasShell) {
          // The shell gives the automation names; the names read before go.
          automationRequest++;
          if (automationNames.delete(host.id)) automationRevision++;
          clearTimeout(timer);
          timer = undefined;
          pendingRecords.clear();
          deltas.clear();
          solus.shells.follow(host.id, host.label);
        } else {
          solus.shells.stop(host.id);
          automationRequest = 0;
        }
        return hasShell;
      };
      const ready = () => {
        const state = solus.connections.state(host.id);
        if (followsShell) solus.shells.sync(host.id);
        if (state?.readiness === "ready" && state.sessionGeneration !== generation) {
          generation = state.sessionGeneration;
          markStart("host_ready");
          const decided = generation;
          const hasShell = readsSessionShell(connection.facts);
          // The choice of path waits for the host's capabilities once, on a connection that has not read them.
          if (!(hasShell instanceof Promise)) startList(hasShell);
          else void hasShell.then((read) => { if (!disposed && generation === decided) startList(read); });
        }
      };
      const startList = (hasShell: boolean) => {
        nearby.onHostReady();
        if (followShell(hasShell)) return;
        const opening = solus.openingDirectory(host.id, "sessions");
        let directoryPage = opening;
        if (opening) {
          const request = ++automationRequest;
          void opening.then(page => {
            if (request !== automationRequest || disposed) return;
            if (page) {
              receiveAutomationNames(page.automations);
            } else {
              automationRequest = 0;
              readAutomationNames();
            }
          }, () => {});
          const pins = solus.threadList.loadPins(host.id, opening.then(page => page?.pins));
          directoryPage = Promise.all([opening, pins]).then(([page]) => page);
        } else if (automationRequest > 0) refreshAutomationNames();
        else readAutomationNames();
        solus.threadList.follow(host.id, opening?.then(page => page?.attention));
        clearTimeout(timer);
        timer = undefined;
        pendingRecords.clear();
        deltas.clear();
        // The first pages of the rows at the top are read once the list is in.
        const listGeneration = generation;
        void solus.threads.load(host.id, 0, "all", directoryPage).then(() => {
          if (!disposed && generation === listGeneration) solus.warmHistory(host.id);
        });
      };
      const stops = [
        connection.events.subscribe("session.executionChanged", ({sessionId, toolId, execution}) => {
          if (toolId) return;
          const queued = deltas.get(sessionId);
          if (queued?.execution && queued.execution.revision >= execution.revision) return;
          deltas.set(sessionId, {...queued, execution});
          scheduleRecords();
        }),
        connection.events.subscribe("session.titleChanged", ({sessionId, title}) => {
          deltas.set(sessionId, {...deltas.get(sessionId), title});
          scheduleRecords();
        }),
        connection.events.subscribe("share.changed", ({resource}) => {
          if (resource.kind === "session") recordChanged({sessionId: resource.id});
        }),
        connection.events.subscribe("session.forkCreated", recordChanged),
        connection.events.subscribe("session.viewChanged", recordChanged),
        connection.events.subscribe("session.stateChanged", recordChanged),
        connection.events.subscribe("session.indexChanged", ({sessionIds}) => {
          for (const sessionId of sessionIds) pendingRecords.add(sessionId);
          scheduleRecords();
        }),
        connection.events.subscribe("projects.changed", () => { if (!followsShell) void solus.threads.load(host.id); }),
        connection.events.subscribe("automation.changed", ({ kind }) => {
          if (automationRequest > 0 && (kind === "saved" || kind === "deleted")) refreshAutomationNames();
        }),
        solus.threads.changes.subscribe(readAutomationNames),
        solus.threads.changes.subscribe(scheduleRecords),
        solus.connections.changes.subscribe(scheduleRecords),
        solus.connections.changes.subscribe(ready),
      ];
      hosts.set(host.id, () => {
        disposed = true;
        if (followsShell) solus.shells.stop(host.id);
        solus.historyPrefetch.cancel(host.id);
        automationRequest++;
        rowReaders.delete(host.id);
        if (automationNames.delete(host.id)) automationRevision++;
        clearTimeout(timer);
        stops.forEach((stop) => stop());
      });
      ready();
    }
    shellCachesRead = [...shellCacheRestores.values()].every(read => read === null);
    hostsChanged();
  }
  const memoryWarning = AppState.addEventListener("memoryWarning", () => solus.releaseRecentConversations());
  const stops = [
    () => memoryWarning.remove(),
    solus.registry.changes.subscribe(reconcile),
    solus.account.changes.subscribe(reconcile),
    solus.connections.changes.subscribe(hostsChanged),
    solus.threads.changes.subscribe(changed),
    solus.threadList.changes.subscribe(changed),
    // A shell's status can change with no change to its rows.
    solus.shells.changes.subscribe(changed),
    // The project lists leave out each container root of a codebase, so the codebases are read for as long as the app runs.
    solus.codebases.watch(),
    // A row of a session in a codebase shows the codebase's badge.
    solus.codebases.changes.subscribe(() => {
      codebaseRevision++;
      changed();
    }),
    watchAppLifecycle(solus.connections, refresh),
  ];
  void solus.load(() => {
    if (!active) return;
    markStart("account_read");
    localReady = true;
    reconcile();
    const stopActivity = installAgentActivity(solus);
    const stopAlerts = installSolusAgentAlerts(solus);
    stopAgentAwareness = () => {
      stopActivity();
      stopAlerts();
    };
  }).then(
    () => {
      if (active) {
        loaded = true;
        void nearby.scan();
        reconcile();
      }
    },
    (error: Error) => {
      if (active) {
        shellCachesRead = true;
        loadError = error.message;
        changed();
      }
    },
  );
  return () => {
    appAtomRegistry.set(shellDirectorySource, null);
    appAtomRegistry.set(mobileHostConnections, null);
    active = false;
    stopAgentAwareness?.();
    stops.forEach((stop) => stop());
    hosts.forEach((stop) => stop());
    shellCacheRestores.clear();
  };
}

const projectThreads = createSessionListProjection(
  (codebaseId, hostId) => solus.codebases.codebaseOf(codebaseId) ??
    (solus.codebases.isDeleted(codebaseId) ? undefined : solus.threads.openingCodebase(hostId, codebaseId)),
  (hostId, automationId) => solus.threads.openingAutomation(hostId, automationId),
);

function readHosts() {
  const environments = solus.registry.hosts().map((host): WorkspaceEnvironment & {supportsListControls: boolean} => {
    const state = solus.connections.state(host.id);
    return {
      environmentId: EnvironmentId.make(host.id),
      environmentLabel: host.label,
      supportsListControls: solus.connections.connection(host.id)?.facts.value("capabilities")?.sessionListControls === true,
      displayUrl: host.routes[0]?.url ?? "",
      isRelayManaged: false,
      isEnabled: true,
      connectionState:
        state?.readiness === "ready"
          ? "connected"
          : state?.readiness === "checking" || state?.readiness === "reconnecting"
            ? "connecting"
            : "offline",
      connectionError: state ? hostReadinessCopy(state, host.label).detail : null,
      connectionErrorTraceId: null,
    };
  });
  return {
    environments,
    hostsById: Object.fromEntries(environments.map((env) => [env.environmentId, env])),
    listHosts: solusListHosts(environments),
  };
}

function readProjects(environments: WorkspaceEnvironment[]) {
  const projects = solus.threads.projects().map(({ hostId, project }) => ({
    environmentId: EnvironmentId.make(hostId),
    id: ProjectId.make(project.path),
    title: project.folderName,
    workspaceRoot: project.path,
    repositoryIdentity: null,
    scripts: [],
    defaultModelSelection: null,
    createdAt: project.addedAt,
    updatedAt: project.lastUsedAt,
  }));
  for (const environment of environments) {
    if (
      environment.connectionState === "connected" &&
      !projects.some((project) => project.environmentId === environment.environmentId)
    ) {
      projects.push({
        environmentId: environment.environmentId,
        id: ProjectId.make("~"),
        title: "Home folder",
        workspaceRoot: "~",
        repositoryIdentity: null,
        scripts: [],
        defaultModelSelection: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
    }
  }

  const projectPaths = new Map<string, Set<string>>();
  for (const project of projects) {
    const paths = projectPaths.get(project.environmentId);
    if (paths) paths.add(project.id);
    else projectPaths.set(project.environmentId, new Set([project.id]));
  }
  return { projects, projectPaths };
}

let seenHostsRevision = -1;
let hosts: ReturnType<typeof readHosts>;
let projects: ReturnType<typeof readProjects>;
let projectSource: ReturnType<typeof solus.threads.projects>;
let workspace: ReturnType<typeof readHosts> & ReturnType<typeof readProjects> & {state: ReturnType<typeof solusWorkspaceState>};
let workspaceRevision = -1;

function getSolusWorkspace() {
  if (workspaceRevision === revision) return workspace;
  let hostChange = false;
  if (seenHostsRevision !== hostsRevision) {
    const next = readHosts();
    hostChange = !hosts || keepEqual(next.environments, hosts.environments) !== hosts.environments;
    if (hostChange) hosts = next;
    seenHostsRevision = hostsRevision;
  }
  const source = solus.threads.projects();
  if (hostChange || source !== projectSource) {
    projectSource = source;
    projects = readProjects(hosts.environments);
  }
  const nextState = solusWorkspaceState(hosts.environments, solus.threads.stateOf, loaded || loadError !== null, loadError);
  const state = workspace ? keepEqual(nextState, workspace.state) : nextState;
  if (!workspace || hosts.environments !== workspace.environments || projects.projects !== workspace.projects || state !== workspace.state) {
    workspace = { ...hosts, ...projects, state };
  }
  workspaceRevision = revision;
  return workspace;
}

export function useSolusWorkspace() {
  return useSyncExternalStore(subscribe, getSolusWorkspace);
}

let projected: {
  rows: ReturnType<typeof solus.threads.threads>;
  facts: ReturnType<typeof solus.threadList.facts>;
  projects: ReturnType<typeof readProjects>["projectPaths"];
  automationRevision: number;
  codebaseRevision: number;
  awayHosts: string;
} | undefined;

function readDirectory() {
  const workspace = getSolusWorkspace();
  const facts = solus.threadList.facts();
  const rows = solus.threads.threads();
  // A host past its reconnect grace marks its rows Offline. A change of that
  // set touches rows whose facts did not change, so it projects every row.
  const away = solus.registry.hosts().filter((host) => solus.connections.readiness(host.id).away).map((host) => host.id);
  const awayKey = away.join(",");
  const keys = projected && solus.threadList.changedKeys(projected.facts);
  const changes = projected && keys && projected.projects === workspace.projectPaths && projected.automationRevision === automationRevision && projected.codebaseRevision === codebaseRevision && projected.awayHosts === awayKey
    ? solus.threads.changedPositions(projected.rows, keys) : undefined;
  const threads = projectThreads(rows, facts, automationNames, workspace.projectPaths, changes, new Set(away));
  projected = { rows, facts, projects: workspace.projectPaths, automationRevision, codebaseRevision, awayHosts: awayKey };
  if (directoryWorkspace === workspace && snapshot.threads === threads && snapshot.unread === facts.unread) return snapshot;
  directoryWorkspace = workspace;
  return { ...workspace, threads, unread: facts.unread };
}
let directoryWorkspace: ReturnType<typeof getSolusWorkspace> | undefined;
let snapshot: ReturnType<typeof getSolusWorkspace> & { threads: ReturnType<typeof projectThreads>; unread: ReturnType<typeof solus.threadList.facts>["unread"] };
let snapshotRevision = -1;
export function getSolusDirectory() {
  if (snapshotRevision !== revision) {
    snapshot = readDirectory();
    snapshotRevision = revision;
  }
  return snapshot;
}
export function useSolusDirectory() {
  return useSyncExternalStore(subscribe, getSolusDirectory);
}

export const solusDirectoryAtom = Atom.make((get) => {
  get.addFinalizer(subscribe(() => get.setSelf(getSolusDirectory())));
  return getSolusDirectory();
});

const navigationRows = createNavigationThreads();
export const navigationThreadsAtom = Atom.make((get) => {
  get.addFinalizer(subscribe(() => get.refreshSelf()));
  const directory = getSolusDirectory();
  const now = Date.now();
  const navigation = navigationRows(directory.threads, directory.environments,
    id => solus.threads.stateOf(id).kind, solus.sessionCache.scope(), now, rowActions,
    id => solus.shells.follows(id) ? solus.shells.progressOf(id) : null);
  if (navigation.releaseAt !== null) {
    const timer = setTimeout(() => get.refreshSelf(), Math.max(0, navigation.releaseAt - now));
    get.addFinalizer(() => clearTimeout(timer));
  }
  return navigation;
});
