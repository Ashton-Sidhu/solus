import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { sameItems } from "@solus/client-core/keep-equal";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import type { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { WorkspaceEnvironment } from "../state/workspaceModel";

interface ShellDirectory {
  readonly environments: readonly Pick<WorkspaceEnvironment, "environmentId" | "environmentLabel" | "isEnabled">[];
  readonly projects: readonly EnvironmentProject[];
  readonly threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "source">[];
  readonly state: { readonly isLoadingConnections: boolean };
}

export const shellDirectorySource = Atom.make<Atom.Atom<ShellDirectory> | null>(null).pipe(Atom.keepAlive);
const empty: ShellDirectory = { environments: [], projects: [], threads: [], state: { isLoadingConnections: true } };
const directory = Atom.make((get) => {
  const source = get(shellDirectorySource);
  return source ? get(source) : empty;
});

const environments = Atom.make((get) => get(directory).environments);
const isReady = Atom.make((get) => !get(directory).state.isLoadingConnections);
export const shellCatalog = Atom.make((get): EnvironmentCatalogState => ({
  isReady: get(isReady),
  entries: new Map(get(environments).map(({ environmentId, environmentLabel, isEnabled }) => [
    environmentId,
    {
      target: new BearerConnectionTarget({ environmentId, connectionId: environmentId, label: environmentLabel }),
      profile: Option.none(),
      enabled: isEnabled,
    },
  ])),
}));

function byHost<T extends { readonly environmentId: EnvironmentId }>(values: readonly T[]) {
  const hosts = new Map<EnvironmentId, T[]>();
  for (const value of values) {
    const rows = hosts.get(value.environmentId);
    if (rows) rows.push(value);
    else hosts.set(value.environmentId, [value]);
  }
  return hosts;
}

const projects = Atom.make((get) => get(directory).projects).pipe(Atom.map(byHost<EnvironmentProject>));
const threads = Atom.make((get) => get(directory).threads).pipe(Atom.map(byHost<ShellDirectory["threads"][number]>));

// The selectors share each host's snapshot. A change on another host keeps
// the same source arrays, so a point read does not rebuild that host's index.
export const hostShellSnapshot = Atom.family((hostId: EnvironmentId) => {
  let previous: OrchestrationV2ShellSnapshot | undefined;
  return Atom.make((get): OrchestrationV2ShellSnapshot => {
    const hostProjects = get(projects).get(hostId) ?? [];
    const hostThreads = get(threads).get(hostId)?.map(thread => thread.source) ?? [];
    const sameProjects = previous && sameItems(previous.projects, hostProjects);
    const sameThreads = previous && sameItems(previous.threads, hostThreads);
    if (previous && sameProjects && sameThreads) return previous;
    previous = {
      schemaVersion: 1,
      snapshotSequence: (previous?.snapshotSequence ?? 0) + 1,
      projects: sameProjects ? previous!.projects : hostProjects,
      threads: sameThreads ? previous!.threads : hostThreads,
      archivedThreads: [],
    };
    return previous;
  });
});
