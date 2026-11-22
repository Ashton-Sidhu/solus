import { useEffect } from "react";
import { solus } from "../solus/runtime";
import { solusIssueList, solusIssueCandidates, sourceScope } from "../solus/source-control";
import {
  createIssueEnvironmentAtoms,
  createMergedIssueCandidatesAtoms,
  createMergedIssueListAtoms,
  type IssueCandidatesTarget,
  type IssueListTarget,
} from "@t3tools/client-runtime/state/issues";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

const mergedIssueLists = createMergedIssueListAtoms(
  {
    list: solusIssueList,
    refreshList: (registry, target) => registry.refresh(solusIssueList(target)),
  },
  formatEnvironmentQueryError,
);

/** One listing read across every environment asked. */
export function useIssueList(targets: ReadonlyArray<IssueListTarget>) {
  const scoped = targets.map((target) => ({ ...target, scope: sourceScope(target.environmentId) }));
  const hostsKey = JSON.stringify(scoped.map((target) => [target.environmentId, target.scope]));
  useEffect(() => {
    const hosts: [EnvironmentId, string][] = JSON.parse(hostsKey);
    const stops = hosts.flatMap(([id]) => {
      const connection = solus.connections.connection(id);
      if (!connection) return [];
      let timer: ReturnType<typeof setTimeout>;
      const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(() => refreshIssueLists(id), 200);
      };
      return [
        connection.events.subscribe("tasks.sourcesChanged", refresh),
        connection.events.subscribe("tasks.invalidated", refresh),
        () => clearTimeout(timer),
      ];
    });
    return () => stops.forEach((stop) => stop());
  }, [hostsKey]);
  const view = useAtomValue(mergedIssueLists.atom(scoped));
  return {
    ...view,
    refresh: () => mergedIssueLists.refresh(appAtomRegistry, targets, "manual"),
  };
}

/** After a write the list cannot see, such as a new issue filed from a sheet. */
export function refreshIssueLists(environmentId: EnvironmentId) {
  mergedIssueLists.refreshEnvironment(appAtomRegistry, environmentId);
}

const mergedIssueCandidates = createMergedIssueCandidatesAtoms(
  solusIssueCandidates,
  formatEnvironmentQueryError,
);

/** The labels and people of every scope a list filter covers; no targets reads nothing. */
export function useIssueFilterCandidates(targets: ReadonlyArray<IssueCandidatesTarget>) {
  return useAtomValue(
    mergedIssueCandidates.atom(
      targets.map((target) => ({ ...target, scope: sourceScope(target.environmentId) })),
    ),
  );
}

/** Asks again only the scopes that failed; the ones that answered keep their answer. */
export function refreshIssueFilterCandidates(targets: ReadonlyArray<IssueCandidatesTarget>) {
  mergedIssueCandidates.retry(appAtomRegistry, targets);
}
