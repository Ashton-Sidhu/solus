import { moveIssue, taskEditCandidates, updateIssue } from "../solus/source-control-actions";
import { hostQueryScope, useHostQueryTargets } from "./host-query-scope";
import { useEffect } from "react";
import { solus } from "../solus/runtime";
import { solusIssueList, solusIssueDetail, solusIssueCandidates } from "../solus/source-control";
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

export const issueEnvironment = {
  ...createIssueEnvironmentAtoms(connectionAtomRuntime),
  list: solusIssueList,
  detail: solusIssueDetail,
  candidates: solusIssueCandidates,
  editCandidates: taskEditCandidates,
  update: updateIssue,
  setState: moveIssue,
};

const mergedIssueLists = createMergedIssueListAtoms(
  {
    list: issueEnvironment.list,
    refreshList: (registry, target) => registry.refresh(issueEnvironment.list(target)),
  },
  formatEnvironmentQueryError,
);

/** One listing read across every environment asked. */
export function useIssueList(targets: ReadonlyArray<IssueListTarget>) {
  const scoped = useHostQueryTargets(targets);
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
    refresh: () => mergedIssueLists.refresh(appAtomRegistry, scoped, "manual"),
  };
}

/** After a write the list cannot see, such as a new issue filed from a sheet. */
export function refreshIssueLists(environmentId: EnvironmentId) {
  mergedIssueLists.refreshEnvironment(appAtomRegistry, environmentId);
}

const mergedIssueCandidates = createMergedIssueCandidatesAtoms(
  issueEnvironment.candidates,
  formatEnvironmentQueryError,
);

/** The labels and people of every scope a list filter covers; no targets reads nothing. */
export function useIssueFilterCandidates(targets: ReadonlyArray<IssueCandidatesTarget>) {
  return useAtomValue(mergedIssueCandidates.atom(useHostQueryTargets(targets)));
}

/** Asks again only the scopes that failed; the ones that answered keep their answer. */
export function refreshIssueFilterCandidates(targets: ReadonlyArray<IssueCandidatesTarget>) {
  mergedIssueCandidates.retry(
    appAtomRegistry,
    targets.map((target) => ({ ...target, scope: hostQueryScope(target.environmentId) })),
  );
}
