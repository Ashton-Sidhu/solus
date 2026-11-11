import { useCallback, useEffect, useMemo, useState } from "react";
import { answerAppCall, type AppCallArguments, type AppCallValue } from "@solus/client-core/app-calls";
import type { HostApi } from "@solus/client-core/host-api";
import { hasAppManifest, type AppState } from "@solus/contracts/apps";

/**
 * An artifact in the feed as an app (docs/plans/apps.md §4): what the host
 * says of it, the network hosts in force for its page, and what answers the
 * page's calls. Null for a page with no app manifest, for a render that was
 * not saved, and while the host is not connected.
 */
export interface ArtifactApp {
  /** Null until the host answered, and when it could not. */
  readonly state: AppState | null;
  readonly network: readonly string[];
  call(name: string, args: AppCallArguments): Promise<AppCallValue>;
  /** The host's owner allows what the app asks of the host, or revokes it. */
  decideHostAccess(allow: boolean): void;
}

export function useArtifactApp(
  api: HostApi | undefined,
  workId: string | null,
  html: string,
  confirm: (title: string, detail: string) => Promise<boolean>,
): ArtifactApp | null {
  const appWorkId = api && workId && hasAppManifest(html) ? workId : null;
  const [state, setState] = useState<AppState | null>(null);

  // A newer page of the same work is a new answer: its permissions and host code may differ.
  useEffect(() => {
    if (!api || !appWorkId) return;
    let current = true;
    api.appRead({ workId: appWorkId }).then(
      (next) => current && setState(next),
      () => current && setState(null),
    );
    return () => {
      current = false;
    };
  }, [api, appWorkId, html]);

  const call = useCallback(
    (name: string, args: AppCallArguments) => {
      if (!api || !appWorkId) return Promise.reject(new Error("This app's host is not connected."));
      return answerAppCall(
        {
          toolInfo: (tool) => api.appToolInfo({ workId: appWorkId, name: tool }),
          callTool: (tool, argumentsJson, approved) => api.appCallTool({ workId: appWorkId, name: tool, argumentsJson, approved }),
          confirm,
        },
        name,
        args,
      );
    },
    [api, appWorkId, confirm],
  );

  const decideHostAccess = useCallback(
    (allow: boolean) => {
      if (api && appWorkId) void api.appHostAccessDecide({ workId: appWorkId, allow }).then(setState, () => undefined);
    },
    [api, appWorkId],
  );

  const network = state?.network;
  return useMemo(
    () => (appWorkId ? { state, network: network ?? [], call, decideHostAccess } : null),
    [appWorkId, state, network, call, decideHostAccess],
  );
}
