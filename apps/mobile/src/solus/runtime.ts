import { AppState } from "react-native";
import { useSyncExternalStore } from "react";
import { hostReadinessCopy } from "@solus/client-core/host-readiness";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SessionRowChange } from "@solus-mobile/features/threads/thread-directory";
import { SolusApp } from "@solus-mobile/app/solus-app";
import { expoPlatform, watchAppLifecycle } from "@solus-mobile/platform/expo";
import type { WorkspaceEnvironment } from "../state/workspaceModel";
import { solusWorkspaceState } from "./workspace-state";
import { solusListHosts } from "./list-hosts";
import { createSessionListProjection } from "./session-list";
import { NearbyDiscovery } from "./discovery";
import { createConversationTransport } from "./transport";

export const solus = new SolusApp({
  ...expoPlatform,
  createTransport: createConversationTransport,
});
export const nearby = new NearbyDiscovery(solus, expoPlatform.storage);
let loaded = false;
let shellCachesRead = false;
export function useSolusShellCachesRead() {
  return useSyncExternalStore(subscribe, () => shellCachesRead);
}
let loadError: string | null = null;
const automationNames = new Map<string, ReadonlyMap<string, string>>();
const rowReaders = new Map<string, (event: { sessionId: string }) => void>();
export function refreshSessionRow(hostId: string, sessionId: string) {
  rowReaders.get(hostId)?.({ sessionId });
}
let revision = 0;
const listeners = new Set<() => void>();
function changed() {
  revision++;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function startSolus() {
  let active = true;
  let localReady = false;
  let scope = "";
  const restores = new Map<string, Promise<void> | null>();
  const hosts = new Map<string, () => void>();
  function refresh() {
    if (loaded) void nearby.scan();
    for (const host of solus.registry.hosts()) {
      if (solus.threads.stateOf(host.id).kind === "error") void solus.threads.load(host.id);
    }
  }
  function reconcile() {
    if (!active || !localReady) return;
    const nextScope = solus.sessionCache.scope();
    if (scope !== nextScope) {
      hosts.forEach(stop => stop());
      hosts.clear();
      restores.clear();
      scope = nextScope;
    }
    const saved = solus.registry.hosts();
    for (const [id, stop] of hosts) {
      if (!saved.some((host) => host.id === id)) {
        stop();
        hosts.delete(id);
      }
    }
    for (const id of restores.keys()) {
      if (!saved.some(host => host.id === id)) restores.delete(id);
    }
    for (const host of saved) {
      if (!restores.has(host.id)) {
        const pending = solus.threads.restore(host.id);
        restores.set(host.id, pending);
        void pending.finally(() => {
          if (!active || restores.get(host.id) !== pending) return;
          restores.set(host.id, null);
          shellCachesRead = [...restores.values()].every(read => read === null);
          changed();
        });
      }
      if (hosts.has(host.id)) continue;
      const connection = solus.connections.connection(host.id);
      if (!connection) continue;
      let generation: number | undefined;
      let automationRequest = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let disposed = false;
      let readingRecords = false;
      const pendingRecords = new Set<string>();
      const deltas = new Map<string, SessionRowChange>();
      const flushRecords = async () => {
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
      const refreshAutomationNames = () => {
        if (solus.connections.state(host.id)?.readiness !== "ready") return;
        const request = ++automationRequest;
        void connection.api.automationList().then((automations) => {
          if (request !== automationRequest) return;
          automationNames.set(host.id, new Map(automations.map(({ id, name }) => [id, name])));
          changed();
        }, () => {
          // Older hosts can still list sessions without answering automation reads.
        });
      };
      const readAutomationNames = () => {
        if (automationRequest > 0) return;
        if (solus.threads.threads().some(({ hostId, record }) =>
          hostId === host.id && record.startedBy?.kind === "automation"
        )) refreshAutomationNames();
      };
      const ready = () => {
        const state = solus.connections.state(host.id);
        if (state?.readiness === "ready" && state.sessionGeneration !== generation) {
          generation = state.sessionGeneration;
          if (automationRequest > 0) refreshAutomationNames();
          else readAutomationNames();
          solus.threadList.follow(host.id);
          nearby.onHostReady();
          clearTimeout(timer);
          timer = undefined;
          pendingRecords.clear();
          deltas.clear();
          void solus.threads.load(host.id);
        }
      };
      const stops = [
        connection.events.subscribe("session.statusChanged", ({sessionId, status, at}) => {
          deltas.set(sessionId, {...deltas.get(sessionId), status: {status, at}});
          scheduleRecords();
        }),
        connection.events.subscribe("session.titleChanged", ({sessionId, title}) => {
          deltas.set(sessionId, {...deltas.get(sessionId), title});
          scheduleRecords();
        }),
        connection.events.subscribe("share.changed", ({resource}) => {
          if (resource.kind === "session") recordChanged({sessionId: resource.id});
        }),
        connection.events.subscribe("session.viewChanged", recordChanged),
        connection.events.subscribe("session.stateChanged", recordChanged),
        connection.events.subscribe("session.indexChanged", ({sessionIds}) => {
          for (const sessionId of sessionIds) pendingRecords.add(sessionId);
          scheduleRecords();
        }),
        connection.events.subscribe("projects.changed", () => { void solus.threads.load(host.id); }),
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
        automationRequest++;
        rowReaders.delete(host.id);
        automationNames.delete(host.id);
        clearTimeout(timer);
        stops.forEach((stop) => stop());
      });
      ready();
    }
    shellCachesRead = [...restores.values()].every(read => read === null);
    changed();
  }
  const memoryWarning = AppState.addEventListener("memoryWarning", () => solus.releaseRecentConversations());
  const stops = [
    () => memoryWarning.remove(),
    solus.registry.changes.subscribe(reconcile),
    solus.account.changes.subscribe(reconcile),
    solus.connections.changes.subscribe(changed),
    solus.threads.changes.subscribe(changed),
    solus.threadList.changes.subscribe(changed),
    watchAppLifecycle(solus.connections, refresh),
  ];
  void solus.load(() => {
    if (!active) return;
    localReady = true;
    reconcile();
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
    active = false;
    stops.forEach((stop) => stop());
    hosts.forEach((stop) => stop());
  };
}

const projectThreads = createSessionListProjection();

function readDirectory() {
  const environments: WorkspaceEnvironment[] = solus.registry.hosts().map((host) => {
    const state = solus.connections.state(host.id);
    return {
      environmentId: EnvironmentId.make(host.id),
      environmentLabel: host.label,
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
  const state = solusWorkspaceState(environments, solus.threads.stateOf, loaded || loadError !== null, loadError);
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
  const facts = solus.threadList.facts();
  const projectPaths = new Map<string, Set<string>>();
  for (const project of projects) {
    const paths = projectPaths.get(project.environmentId);
    if (paths) paths.add(project.id);
    else projectPaths.set(project.environmentId, new Set([project.id]));
  }
  const threads = projectThreads(solus.threads.threads(), facts, automationNames, projectPaths);
  const hostsById = Object.fromEntries(environments.map((env) => [env.environmentId, env]));
  return { projects, threads, environments, hostsById, state, unread: facts.unread, listHosts: solusListHosts(environments) };
}
let snapshot: ReturnType<typeof readDirectory>;
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
