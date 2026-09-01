import type { AgentId, SessionMeta } from "@solus/contracts/types";
import { readSessionMeta } from "@solus/client-core/session-meta";

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

const AGENT_PROVIDERS = new Set<string>([
  "claude-code",
  "codex",
  "opencode",
]);

function isAgentId(value: string): value is AgentId {
  return AGENT_PROVIDERS.has(value);
}

/** A session link has two spellings: agent tools write `session://open`, the
 *  input bar's reference picker writes `session://ref` like every other
 *  reference token. Both name the same destination. */
const SESSION_LINK_HOSTS = new Set(["open", "ref"]);

export function parseSessionHref(href: string): SessionLinkParams | null {
  try {
    const url = new URL(href);
    const provider = url.searchParams.get("provider");
    const sessionId = url.searchParams.get("sessionId");

    if (
      url.protocol !== "session:" ||
      !SESSION_LINK_HOSTS.has(url.hostname) ||
      !provider ||
      !isAgentId(provider) ||
      !sessionId
    ) {
      return null;
    }

    return {
      provider,
      sessionId,
      serverId: url.searchParams.get("serverId"),
      cwd: url.searchParams.get("cwd"),
    };
  } catch {
    return null;
  }
}
