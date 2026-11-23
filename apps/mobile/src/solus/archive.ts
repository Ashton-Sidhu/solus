import { hostQuery } from "./host-query";
import { usesWindowFilter, visibleInWindow } from "@solus/client-core/organization-filter";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { mobileHost } from "../state/mobile-host";
import { sessionShell } from "./session";
import { solus } from "./runtime";

const readArchive = hostQuery(
  async (hostId, _input: null): Promise<OrchestrationV2ArchivedShellSnapshot> => {
    const api = solus.connections.connection(hostId)?.api;
    if (!api) throw new Error("Host disconnected");
    const organizationId = solus.account.organizationId;
    const { records } = await api.sessionRecordList({
      scope: "all",
      includeWorktrees: true,
    });
    const filter = usesWindowFilter(hostId, solus.threads.managedHostIds());
    const threads = records
      .filter(
        (record) =>
          record.view?.archivedAt != null &&
          visibleInWindow(record.organizationId, organizationId, filter),
      )
      .map((record) => sessionShell(record));
    const projects = new Map<string, OrchestrationProjectShell>();
    const knownProjects = new Map(
      solus.threads
        .projects()
        .filter((row) => row.hostId === hostId)
        .map(({ project }) => [project.path, project]),
    );
    for (const thread of threads) {
      if (projects.has(thread.projectId)) continue;
      const project = knownProjects.get(thread.projectId);
      const createdAt = new Date(thread.createdAt.epochMilliseconds).toISOString();
      projects.set(thread.projectId, {
        id: thread.projectId,
        title:
          project?.folderName ??
          (thread.projectId === "~"
            ? "Home folder"
            : thread.projectId.split("/").filter(Boolean).pop() || thread.projectId),
        workspaceRoot: thread.projectId,
        defaultModelSelection: null,
        scripts: [],
        createdAt: project?.addedAt ?? createdAt,
        updatedAt: project?.lastUsedAt ?? createdAt,
      });
    }
    return { schemaVersion: 1, snapshotSequence: 0, threads, projects: [...projects.values()] };
  },
  0,
);

export const archivedSnapshotAtom = Atom.family((id: EnvironmentId) => {
  const source = readArchive({ environmentId: id, input: null });
  return Atom.readable(
    (get) => {
      const host = get(mobileHost(id));
      if (host)
        get.addFinalizer(host.events.subscribe("session.viewChanged", () => get.refresh(source)));
      return get(source);
    },
    (refresh) => refresh(source),
  );
});
