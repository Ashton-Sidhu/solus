import type { AgentId, SessionMeta } from "../../../../shared/types";
import { resolveSessionMetaRef, stampSessionMeta } from "@client-core/session-meta";

export interface SessionLinkParams {
  provider: AgentId;
  sessionId: string;
  /** Explicit destination host. A bare legacy link inherits its transcript host. */
  serverId: string | null;
  /** Working directory carried in the link so a cross-project session opens in
   *  the right directory even when the index lookup misses. */
  cwd: string | null;
}

/** Resolve the linked session's real metadata (cwd/projectPath drive which tab
 *  directory it resumes into). Prefer the index; fall back to the cwd embedded
 *  in the link so cross-project opens still land in the right directory. */
export async function resolveSessionLinkMeta(
  params: SessionLinkParams,
  sourceServerId?: string,
  resolve: typeof resolveSessionMetaRef = resolveSessionMetaRef,
): Promise<SessionMeta> {
  const serverId = params.serverId ?? sourceServerId;
  const resolved = await resolve({ sessionId: params.sessionId, serverId }).catch(() => null);
  const meta = resolved && serverId && !resolved.serverId
    ? stampSessionMeta(resolved, serverId)
    : resolved;
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

const AGENT_PROVIDERS = new Set<AgentId>([
  "claude-code",
  "codex",
  "opencode",
]);

export function parseSessionHref(href: string): SessionLinkParams | null {
  try {
    const url = new URL(href);
    const provider = url.searchParams.get("provider");
    const sessionId = url.searchParams.get("sessionId");

    if (
      url.protocol !== "session:" ||
      url.hostname !== "open" ||
      !provider ||
      !AGENT_PROVIDERS.has(provider as AgentId) ||
      !sessionId
    ) {
      return null;
    }

    return {
      provider: provider as AgentId,
      sessionId,
      serverId: url.searchParams.get("serverId"),
      cwd: url.searchParams.get("cwd"),
    };
  } catch {
    return null;
  }
}
