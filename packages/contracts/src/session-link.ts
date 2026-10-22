import type { AgentId } from "./types";

/**
 * A link to a session, as an agent writes it in its reply (`session://open`)
 * or the input bar's reference picker writes it (`session://ref`). Desktop,
 * web, and mobile read it here, so a link opens the same session on each.
 */
export interface SessionLinkParams {
  provider: AgentId;
  sessionId: string;
  /** Explicit destination host. A bare legacy link inherits its transcript host. */
  serverId: string | null;
  /** Working directory carried in the link so a cross-project session opens in
   *  the right directory even when the index lookup misses. */
  cwd: string | null;
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
