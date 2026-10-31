import { z } from "zod";
import type { AgentId, SessionReference } from "./types";

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
  "replay",
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

/** The `session://ref` href of a session reference. */
export function sessionReferenceHref(reference: SessionReference): string {
  const params = new URLSearchParams({
    sessionId: reference.sessionId,
    provider: reference.provider,
    cwd: reference.cwd,
  });
  if (reference.serverId) params.set("serverId", reference.serverId);
  return `session://ref?${params}`;
}

/** A session as a prompt names it: `[title](session://ref?…)`, the chip the
 *  input bar's reference picker inserts. Every client writes it here, so the
 *  composer turns it into the same `SessionReference` and the agent reads the
 *  session with read_session. */
export function sessionReferenceMarkdown(reference: SessionReference): string {
  const label = reference.title.replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `[${label}](${sessionReferenceHref(reference)})`;
}

const sessionReferenceSchema = z.object({
  sessionId: z.string().refine((id) => id.trim().length > 0),
  provider: z.enum(["claude-code", "codex", "opencode", "replay"]),
  title: z.string(),
  cwd: z.string(),
  serverId: z.string().optional(),
}) satisfies z.ZodType<SessionReference>;
const entriesSchema = z.array(z.unknown());

/** The session references in a JSON list another surface wrote, such as a
 *  dragged session. An entry that is not a reference is left out. */
export function parseSessionReferences(json: string): SessionReference[] {
  let entries: z.infer<typeof entriesSchema>;
  try {
    const parsed = entriesSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return [];
    entries = parsed.data;
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const reference = sessionReferenceSchema.safeParse(entry);
    return reference.success ? [reference.data] : [];
  });
}
