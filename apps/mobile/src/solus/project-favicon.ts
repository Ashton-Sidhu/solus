import { faviconCandidatePaths } from "@solus/client-core/project-favicon-paths";
import { isChat } from "@solus/contracts/chat";
import { isAbsoluteHostPath, joinHostPath } from "@solus/contracts/host-path";
import type { HostApi } from "@solus/client-core/host-api";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";

export async function findProjectFavicon(
  api: Pick<HostApi, "assetFindUrl">,
  cwd: string,
  path?: string,
) {
  const paths = path
    ? [isAbsoluteHostPath(path) ? path : joinHostPath(cwd, path)]
    : faviconCandidatePaths(cwd);
  const found =
    cwd && cwd !== "~" && !isChat(cwd) ? await api.assetFindUrl(undefined, { paths }) : null;
  // Upstream uses this marker to clear a previously cached image on a confirmed miss.
  return found ?? { relativeUrl: "/" + PROJECT_FAVICON_FALLBACK_MARKER, expiresAt: 0 };
}
