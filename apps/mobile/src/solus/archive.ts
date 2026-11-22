import { useFocusEffect } from "@react-navigation/native";
import { usesWindowFilter, visibleInWindow } from "@solus/client-core/organization-filter";
import { EnvironmentId, type OrchestrationProjectShell } from "@t3tools/contracts";
import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import { useCallback, useReducer, useState, useSyncExternalStore } from "react";
import { sessionShell } from "./session";
import { solus } from "./runtime";

async function readArchive(
  hostId: string,
  organizationId: string | null,
): Promise<ArchivedSnapshotEntry> {
  const connection = solus.connections.connection(hostId);
  if (!connection) throw new Error("Host disconnected");
  const { records } = await connection.api.sessionRecordList({
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
  return {
    environmentId: EnvironmentId.make(hostId),
    snapshot: { schemaVersion: 1, snapshotSequence: 0, threads, projects: [...projects.values()] },
  };
}

export function useSolusArchive(connectedHosts: ReadonlySet<EnvironmentId>) {
  const hostKey = [...connectedHosts].sort().join("\n");
  const organizationId = useSyncExternalStore(
    solus.account.changes.subscribe,
    () => solus.account.organizationId,
  );
  const [generation, refresh] = useReducer((value: number) => value + 1, 0);
  const [result, setResult] = useState<{
    hostKey: string;
    organizationId: string | null;
    snapshots: ArchivedSnapshotEntry[];
    error: string | null;
    isLoading: boolean;
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const hostIds = hostKey ? hostKey.split("\n") : [];
      setResult((previous) => previous && { ...previous, isLoading: true });
      void Promise.allSettled(hostIds.map((id) => readArchive(id, organizationId))).then(
        (reads) => {
          if (!active) return;
          const snapshots = reads.flatMap((read) =>
            read.status === "fulfilled" ? [read.value] : [],
          );
          const errors = reads.flatMap((read, i) =>
            read.status === "rejected" ? [hostIds[i] + ": " + String(read.reason)] : [],
          );
          setResult({
            hostKey,
            organizationId,
            snapshots,
            error:
              errors.join("\n") ||
              (hostIds.length ? null : "Connect to a host to see archived sessions."),
            isLoading: false,
          });
        },
      );
      return () => {
        active = false;
      };
    }, [hostKey, organizationId, generation]),
  );
  const current =
    result?.hostKey === hostKey && result.organizationId === organizationId ? result : null;
  return {
    snapshots: current?.snapshots ?? [],
    error: current?.error ?? null,
    isLoading: current?.isLoading ?? true,
    refresh,
  };
}
