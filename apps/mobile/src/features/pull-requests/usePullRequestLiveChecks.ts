import { useEffect, useSyncExternalStore } from "react";
import { useAtomRefresh } from "@effect/atom-react";
import { solus } from "../../solus/runtime";
import { useFocusEffect } from "@react-navigation/native";
import {
  pullRequestChecksRefreshIntervalMs,
  resolvePullRequestDetailChecks,
} from "@t3tools/client-runtime/pull-request-checks";
import type { PullRequestDetail } from "@t3tools/contracts";
import { useEnvironmentServerConfig } from "../../state/entities";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

/**
 * Re-reads only the checks while an open change request is on screen, so a running CI shows up
 * without paying for a full detail read every poll.
 */
export function usePullRequestLiveChecks(
  params: PullRequestParams,
  detail: PullRequestDetail | null,
): PullRequestDetail | null {
  const target = pullRequestTarget(params);
  const connected = usePullRequestConnected(target.environmentId);
  const supported =
    useEnvironmentServerConfig(target.environmentId)?.environment.capabilities.pullRequestChecks ===
    true;
  const { environmentId } = target;
  const number = params.number;
  const host = params.host ?? (detail && URL.canParse(detail.url) ? new URL(detail.url).host : null);
  const repository = host ? `${host}/${params.repository}`.toLowerCase() : null;
  useEffect(() => {
    if (connected && repository) return solus.pullRequests.wantLinked(environmentId, repository, number);
  }, [connected, environmentId, repository, number]);
  const pushed = useSyncExternalStore(solus.pullRequests.changes.subscribe, () =>
    connected && repository ? solus.pullRequests.linkedOf(environmentId, repository, number) : null,
  );
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const headChanged = !!(detail && pushed && pushed.updatedAt >= detail.updatedAt && pushed.headSha !== detail.headSha);
  useEffect(() => {
    if (headChanged) refreshDetail();
  }, [headChanged, pushed?.headSha, refreshDetail]);
  const current = detail && pushed && !headChanged && pushed.updatedAt >= detail.updatedAt
    && (pushed.state !== detail.state || pushed.draft !== detail.isDraft
      || pushed.autoMergeEnabled !== undefined && (pushed.autoMergeEnabled !== detail.autoMergeEnabled
        || pushed.autoMergeMethod !== detail.autoMergeMethod))
    ? { ...detail, state: pushed.state, isDraft: pushed.draft,
        autoMergeEnabled: pushed.autoMergeEnabled ?? detail.autoMergeEnabled,
        autoMergeMethod: pushed.autoMergeEnabled === undefined ? detail.autoMergeMethod : pushed.autoMergeMethod }
    : detail;
  const checks = useEnvironmentQuery(
    supported && detail !== null ? composerPullRequests.checks(target) : null,
  );
  // Both reads carry the server's observedAt; without it the poll is the fresher stream.
  const live = resolvePullRequestDetailChecks(current, checks.data, true);
  // A failed read keeps polling; only a host that answers "no checks" (null) stops it.
  const enabled =
    connected && supported && live?.state === "open" && !(checks.isSuccess && checks.data === null);
  const intervalMs = pullRequestChecksRefreshIntervalMs(live?.checks ?? []);
  const { refresh } = checks;
  useFocusEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  });
  return live;
}
