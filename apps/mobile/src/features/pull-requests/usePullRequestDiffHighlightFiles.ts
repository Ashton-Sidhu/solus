import { useMemo, useCallback, useContext } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { prDiffContents } from "../../solus/source-control";
import { RegistryContext } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { useHostQueryTargets } from "../../state/host-query-scope";
import type { PullRequestDiffFileContentsInput } from "@t3tools/contracts";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import { diffHighlightTraceHash, traceDiffHighlight } from "../diffs/nativeReviewDiffTrace";
import type { ReviewParsedDiff } from "../review/reviewModel";
import {
  createPullRequestDiffHighlightCache,
  createPullRequestDiffHighlightFiles,
} from "./pullRequestDiffHighlightFiles";
import { pullRequestTarget, type PullRequestDiffParams } from "./usePullRequestDiff";

function traceSourceEndpoint(environmentId: string, url: string) {
  try {
    const endpoint = new URL(url);
    traceDiffHighlight("source-endpoint", {
      environment: diffHighlightTraceHash(environmentId),
      origin: diffHighlightTraceHash(endpoint.origin),
      port: endpoint.port || (endpoint.protocol === "https:" ? "443" : "80"),
    });
  } catch {
    traceDiffHighlight("source-endpoint-invalid");
  }
}

export function usePullRequestDiffHighlightFiles(
  params: PullRequestDiffParams,
  parsed: ReviewParsedDiff,
  files: ReadonlyArray<NativeReviewDiffFile>,
  expectedHead?: string,
) {
  const registry = useContext(RegistryContext);
  const scope = useHostQueryTargets([{ environmentId: params.environmentId }])[0]!.scope;
  const fetchContents = useCallback(
    (target: { environmentId: EnvironmentId; input: PullRequestDiffFileContentsInput }) =>
      executeAtomQuery(
        registry,
        prDiffContents({ ...target, scope, input: { ...target.input, expectedHead } }),
        { reportFailure: false },
      ),
    [registry, scope, expectedHead],
  );
  const { environmentId, projectId, repository, number, host, commit } = params;
  const cache = useMemo(createPullRequestDiffHighlightCache, [scope, expectedHead]);
  return useMemo(() => {
    if (process.env.EXPO_PUBLIC_T3_DIFF_TRACE === "1") {
      const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
      const entry = catalog.entries.get(EnvironmentId.make(environmentId));
      const profile = entry && Option.getOrUndefined(entry.profile);
      const url =
        entry?.target._tag === "PrimaryConnectionTarget"
          ? entry.target.httpBaseUrl
          : profile?._tag === "BearerConnectionProfile"
            ? profile.httpBaseUrl
            : undefined;
      if (url) {
        traceSourceEndpoint(environmentId, url);
      } else traceDiffHighlight("source-endpoint-unavailable");
    }
    return createPullRequestDiffHighlightFiles(
      {
        target: pullRequestTarget({ environmentId, projectId, repository, number, host }),
        commit,
      },
      parsed,
      files,
      fetchContents,
      cache,
    );
  }, [
    environmentId,
    projectId,
    repository,
    number,
    host,
    commit,
    parsed,
    files,
    fetchContents,
    cache,
  ]);
}
