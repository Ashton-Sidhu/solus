import type { SessionMeta } from "@solus/contracts/types";
import type { SessionLinkParams } from "@solus/contracts/session-link";
import { readSessionMeta } from "@solus/client-core/session-meta";

/** Resolve the linked session's real metadata (cwd/projectPath drive which tab
 *  directory it resumes into). Prefer the index; fall back to the cwd embedded
 *  in the link so cross-project opens still land in the right directory. A
 *  link without a host (and no transcript host to inherit) is never probed —
 *  the fallback meta carries no serverId and the resume refuses it. */
export async function resolveSessionLinkMeta(
  params: SessionLinkParams,
  sourceServerId?: string,
  resolve: typeof readSessionMeta = readSessionMeta,
): Promise<SessionMeta> {
  const serverId = params.serverId ?? sourceServerId;
  const meta = serverId
    ? await resolve(serverId, params.sessionId).catch(() => null)
    : null;
  if (meta?.cwd) return meta;
  return (
    meta ?? {
      provider: params.provider,
      sessionId: params.sessionId,
      slug: null,
      firstMessage: null,
      lastTimestamp: "",
      size: 0,
      cwd: params.cwd ?? "",
      projectPath: "",
      serverId,
    }
  );
}
