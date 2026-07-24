import type { AgentId, SessionMeta } from "../../../../shared/types";

export interface SessionLinkParams {
  provider: AgentId;
  sessionId: string;
  /** Working directory carried in the link so a cross-project session opens in
   *  the right directory even when the index lookup misses. */
  cwd: string | null;
}

/** Resolve the linked session's real metadata (cwd/projectPath drive which tab
 *  directory it resumes into). Prefer the index; fall back to the cwd embedded
 *  in the link so cross-project opens still land in the right directory. */
export async function resolveSessionLinkMeta(
  params: SessionLinkParams,
): Promise<SessionMeta> {
  const meta = await window.solus
    .getSessionInfo(params.sessionId)
    .catch(() => null);
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

    return { provider: provider as AgentId, sessionId, cwd: url.searchParams.get("cwd") };
  } catch {
    return null;
  }
}
