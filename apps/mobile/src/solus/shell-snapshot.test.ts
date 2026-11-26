import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { v2Project, v2ThreadShell } from "../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { expect, it } from "vite-plus/test";
import { hostShellSnapshot, shellCatalog, shellDirectorySource } from "./shell-snapshot";

it("keeps lookups local to their host and drops the previous account on a scope change", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const projectId = ProjectId.make("/workspace");
  const projects = [local, remote].map(environmentId => ({ ...v2Project, id: projectId, title: environmentId, environmentId }));
  const initial = {
    projects,
    environments: [local, remote].map(environmentId => ({ environmentId, environmentLabel: environmentId, isEnabled: true })),
    state: { isLoadingConnections: false },
    threads: [{ environmentId: local, source: v2ThreadShell }],
  };
  const directory = Atom.make(initial);
  const registry = AtomRegistry.make();
  const selectors = createEnvironmentProjectAtoms({ catalogValueAtom: shellCatalog, snapshotAtom: hostShellSnapshot });
  const ref = selectors.projectAtom({ projectId, environmentId: remote });
  registry.set(shellDirectorySource, directory);
  const stop = registry.mount(selectors.projectsAtom);
  try {
    expect(registry.get(selectors.projectsAtom)).toHaveLength(2);
    expect(registry.get(ref)?.title).toBe(remote);
    const remoteSnapshot = registry.get(hostShellSnapshot(remote));
    registry.set(directory, { ...initial, threads: [{ environmentId: local, source: { ...v2ThreadShell, id: ThreadId.make("second") } }] });
    expect(registry.get(hostShellSnapshot(remote))).toBe(remoteSnapshot);
    registry.set(directory, { ...initial, environments: [], threads: [], projects: [] });
    expect(registry.get(ref)).toBeNull();
    expect(registry.get(selectors.projectsAtom)).toEqual([]);
  } finally {
    stop();
    registry.dispose();
  }
});
