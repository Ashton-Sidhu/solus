import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useMemo, useState } from "react";

import { useSolusWorkspace } from "../../solus/runtime";
import { useArchivedThreadSnapshots } from "./useArchivedThreadSnapshots";
import { listActions } from "../../solus/list-actions";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import { buildArchivedThreadGroups, type ArchivedThreadSortOrder } from "./archivedThreadList";
export function ArchivedThreadsRouteScreen() {
  const { hostsById: savedConnectionsById, listHosts } = useSolusWorkspace();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sortOrder, setSortOrder] = useState<ArchivedThreadSortOrder>("newest");
  const environments = useMemo<ReadonlyArray<ArchivedThreadsHeaderEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(Order.String, (environment: ArchivedThreadsHeaderEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [savedConnectionsById],
  );
  const environmentLabels = useMemo(
    () =>
      Object.fromEntries(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const connectedIds = useMemo(() => [...listHosts.connectedEnvironmentIds], [listHosts.connectedEnvironmentIds]);
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(connectedIds);
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentLabels,
        environmentId: selectedEnvironmentId,
        searchQuery,
        sortOrder,
      }),
    [environmentLabels, searchQuery, selectedEnvironmentId, snapshots, sortOrder],
  );
  return (
    <ArchivedThreadsScreen
      environments={environments}
      error={connectedIds.length ? error : "Connect to a host to see archived sessions."}
      groups={groups}
      isLoading={isLoading}
      connectedHosts={listHosts.connectedEnvironmentIds}
      onEnvironmentChange={setSelectedEnvironmentId}
      onRefresh={refresh}
      onSearchQueryChange={setSearchQuery}
      onSortOrderChange={setSortOrder}
      onUnarchiveThread={async (thread) => {
        if (await listActions.unarchiveThread(thread)) refresh();
      }}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sortOrder={sortOrder}
    />
  );
}
