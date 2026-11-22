import { useSyncExternalStore } from "react";
import { hostReadinessCopy } from "@solus/client-core/host-readiness";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { SolusApp } from "@solus-mobile/app/solus-app";
import { expoPlatform, watchAppLifecycle } from "@solus-mobile/platform/expo";
import {
  projectWorkspaceConnectionState,
  type WorkspaceEnvironment,
} from "../state/workspaceModel";
import { toThreadShell } from "./session";
import { NearbyDiscovery } from "./discovery";
import { createConversationTransport } from "./transport";

export const solus = new SolusApp({
  ...expoPlatform,
  createTransport: createConversationTransport,
});
export const nearby = new NearbyDiscovery(solus, expoPlatform.storage);
let loaded = false;
let loadError: string | null = null;
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
  const hosts = new Map<string, () => void>();
  function refresh() {
    if (loaded) void nearby.scan();
    for (const host of solus.registry.hosts()) void solus.threads.load(host.id);
  }
  function reconcile() {
    if (!loaded) return;
    const saved = solus.registry.hosts();
    for (const [id, stop] of hosts) {
      if (!saved.some((host) => host.id === id)) {
        stop();
        hosts.delete(id);
      }
    }
    for (const host of saved) {
      if (hosts.has(host.id)) continue;
      const connection = solus.connections.connection(host.id);
      if (!connection) continue;
      let generation: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refreshList = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void solus.threads.load(host.id), 180);
      };
      const ready = () => {
        const state = solus.connections.state(host.id);
        if (state?.readiness === "ready" && state.sessionGeneration !== generation) {
          generation = state.sessionGeneration;
          solus.threadList.follow(host.id);
          nearby.onHostReady();
          refreshList();
        }
      };
      const stops = [
        connection.events.subscribe("session.statusChanged", refreshList),
        connection.events.subscribe("session.titleChanged", refreshList),
        connection.events.subscribe("share.changed", refreshList),
        solus.connections.changes.subscribe(ready),
      ];
      hosts.set(host.id, () => {
        clearTimeout(timer);
        stops.forEach((stop) => stop());
      });
      ready();
    }
    changed();
  }
  const stops = [
    solus.registry.changes.subscribe(reconcile),
    solus.connections.changes.subscribe(changed),
    solus.threads.changes.subscribe(changed),
    solus.threadList.changes.subscribe(changed),
    watchAppLifecycle(solus.connections, refresh),
  ];
  void solus.load().then(
    () => {
      if (active) {
        loaded = true;
        void nearby.scan();
        reconcile();
      }
    },
    (error: Error) => {
      if (active) {
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

function iso(time: number | null | undefined) {
  return time == null ? null : new Date(time).toISOString();
}

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
  const states = environments.map((env) => solus.threads.stateOf(env.environmentId));
  const state = {
    ...projectWorkspaceConnectionState({
      isReady: loaded || !!loadError,
      networkStatus: "unknown",
      environments,
    }),
    hasLoadedShellSnapshot: states.some((s) => s.kind === "loaded"),
    hasPendingShellSnapshot: states.some((s) => s.kind === "loading"),
    hasSyncingConnectedEnvironment: false,
    shellSnapshotError: loadError ?? states.find((s) => s.kind === "error")?.message ?? null,
  };
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
  const threads = solus.threads.threads().map(({ hostId, record, key }) => {
    const shell = toThreadShell(hostId, record);
    const view = facts.views.get(key) ?? record.view;
    const settled = view?.settledAt ?? (facts.states.get(key) ?? record.state)?.settledAt;
    const pinned = facts.pins?.get(key)?.pinnedAt;
    return {
      ...shell,
      archivedAt: iso(view?.archivedAt),
      settledAt: iso(settled),
      settledOverride: settled ? ("settled" as const) : null,
      snoozedUntil: iso(view?.snoozedUntil),
      pinnedAt: iso(pinned),
    };
  });
  const hostsById = Object.fromEntries(environments.map((env) => [env.environmentId, env]));
  return { projects, threads, environments, hostsById, state };
}
let snapshot: ReturnType<typeof readDirectory>;
let snapshotRevision = -1;
function getDirectory() {
  if (snapshotRevision !== revision) {
    snapshot = readDirectory();
    snapshotRevision = revision;
  }
  return snapshot;
}
export function useSolusDirectory() {
  return useSyncExternalStore(subscribe, getDirectory);
}
