import type {
  AgentId,
  PlanReference,
  SessionReference,
  WorkReference,
} from "../../../shared/types";

export interface FileReferenceToken {
  kind: "file";
  path: string;
  name: string;
}

export interface PlanReferenceToken extends PlanReference {
  kind: "plan";
}

export interface WorkReferenceToken extends WorkReference {
  kind: "work";
}

export interface PrReferenceToken {
  kind: "pr";
  number: number;
  title: string;
}

export interface SlashReferenceToken {
  kind: "slash";
  command: string;
}

export interface SessionReferenceToken extends SessionReference {
  kind: "session";
}

/** Tasks and automations are pointers only: the chip carries the id so the
 *  label can be re-resolved at render, and the markdown link carries enough
 *  text for the agent to act on it without a store lookup. */
export interface TaskReferenceToken {
  kind: "task";
  taskId: string;
  title: string;
}

export interface AutomationReferenceToken {
  kind: "automation";
  automationId: string;
  title: string;
}

export type ReferenceToken =
  | FileReferenceToken
  | PlanReferenceToken
  | WorkReferenceToken
  | PrReferenceToken
  | SlashReferenceToken
  | SessionReferenceToken
  | TaskReferenceToken
  | AutomationReferenceToken;

export interface ReferenceTokenRange {
  from: number;
  to: number;
  token: ReferenceToken;
}

export interface ReferenceParseOptions {
  slashCommands?: Iterable<string>;
}

const CUSTOM_REFERENCE_RE =
  /\[((?:\\.|[^\]\\\n])*)\]\(((?:plan|work|pr|session|task|automation):\/\/[^)\s]*)\)/g;
const FILE_REFERENCE_RE = /(^|\s)@([^\s]+)/g;
const SLASH_REFERENCE_RE = /(^|\s)(\/[a-zA-Z-]+)/g;
const AGENT_IDS = new Set<AgentId>(["claude-code", "codex", "opencode"]);

function isPlanStatus(value: string): value is PlanReference["status"] {
  return value === "pending" || value === "accepted" || value === "rejected";
}

function isWorkType(value: string): value is WorkReference["type"] {
  return value === "doc" || value === "slides" || value === "diagram";
}

function isAgentId(value: string): value is AgentId {
  return value === "claude-code" || value === "codex" || value === "opencode";
}

function basename(path: string): string {
  const stripped = path.replace(/\/+$/, "");
  const index = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return index === -1 ? stripped : stripped.slice(index + 1);
}

function escapeLabel(label: string): string {
  return label.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function unescapeLabel(label: string): string {
  return label.replaceAll("\\[", "[").replaceAll("\\]", "]");
}

function stringParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value?.trim() ? value : null;
}

function parseCustomReference(label: string, href: string): ReferenceToken | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const title = unescapeLabel(label);
  if (url.protocol === "plan:") {
    const planId = stringParam(url, "planId");
    const sessionId = stringParam(url, "sessionId");
    const planToolUseId = stringParam(url, "planToolUseId");
    const status = url.searchParams.get("status") ?? "pending";
    if (
      !planId ||
      !sessionId ||
      !planToolUseId ||
      !isPlanStatus(status)
    )
      return null;
    return {
      kind: "plan",
      planId,
      sessionId,
      planToolUseId,
      title,
      status,
    };
  }

  if (url.protocol === "work:") {
    const workId = stringParam(url, "workId");
    const type = url.searchParams.get("type") ?? "doc";
    if (!workId || !isWorkType(type)) return null;
    return {
      kind: "work",
      workId,
      title,
      type,
    };
  }

  if (url.protocol === "pr:") {
    const number = Number(url.searchParams.get("number"));
    if (!Number.isInteger(number) || number <= 0) return null;
    return {
      kind: "pr",
      number,
      title: title.replace(new RegExp(`^#${number}\\s*`), ""),
    };
  }

  if (url.protocol === "session:") {
    const sessionId = stringParam(url, "sessionId");
    const provider = url.searchParams.get("provider");
    if (!sessionId || !provider || !isAgentId(provider) || !AGENT_IDS.has(provider)) return null;
    const token: SessionReferenceToken = {
      kind: "session",
      sessionId,
      provider,
      title,
      cwd: url.searchParams.get("cwd") ?? "",
    };
    const serverId = url.searchParams.get("serverId");
    if (serverId) token.serverId = serverId;
    return token;
  }

  if (url.protocol === "task:") {
    const taskId = stringParam(url, "taskId");
    if (!taskId) return null;
    return { kind: "task", taskId, title };
  }

  if (url.protocol === "automation:") {
    const automationId = stringParam(url, "automationId");
    if (!automationId) return null;
    return { kind: "automation", automationId, title };
  }

  return null;
}

function overlaps(
  ranges: readonly ReferenceTokenRange[],
  from: number,
  to: number,
): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

export function serializeReferenceToken(token: ReferenceToken): string {
  switch (token.kind) {
    case "file":
      return `@${token.path}`;
    case "slash":
      return token.command;
    case "plan": {
      const params = new URLSearchParams({
        planId: token.planId,
        sessionId: token.sessionId,
        planToolUseId: token.planToolUseId,
        status: token.status,
      });
      return `[${escapeLabel(token.title)}](plan://ref?${params})`;
    }
    case "work": {
      const params = new URLSearchParams({
        workId: token.workId,
        type: token.type,
      });
      return `[${escapeLabel(token.title)}](work://ref?${params})`;
    }
    case "pr": {
      const params = new URLSearchParams({ number: String(token.number) });
      return `[#${token.number} ${escapeLabel(token.title)}](pr://ref?${params})`;
    }
    case "session": {
      const params = new URLSearchParams({
        sessionId: token.sessionId,
        provider: token.provider,
        cwd: token.cwd,
      });
      if (token.serverId) params.set("serverId", token.serverId);
      return `[${escapeLabel(token.title)}](session://ref?${params})`;
    }
    case "task": {
      const params = new URLSearchParams({ taskId: token.taskId });
      return `[${escapeLabel(token.title)}](task://ref?${params})`;
    }
    case "automation": {
      const params = new URLSearchParams({ automationId: token.automationId });
      return `[${escapeLabel(token.title)}](automation://ref?${params})`;
    }
  }
}

export function parseReferenceTokens(
  text: string,
  options: ReferenceParseOptions = {},
): ReferenceTokenRange[] {
  const ranges: ReferenceTokenRange[] = [];
  for (const match of text.matchAll(CUSTOM_REFERENCE_RE)) {
    if (match.index === undefined) continue;
    const token = parseCustomReference(match[1], match[2]);
    if (!token) continue;
    ranges.push({
      from: match.index,
      to: match.index + match[0].length,
      token,
    });
  }

  for (const match of text.matchAll(FILE_REFERENCE_RE)) {
    if (match.index === undefined) continue;
    const from = match.index + match[1].length;
    const to = from + 1 + match[2].length;
    if (overlaps(ranges, from, to)) continue;
    const path = match[2];
    ranges.push({
      from,
      to,
      token: { kind: "file", path, name: basename(path) },
    });
  }

  const commands = new Set(
    Array.from(options.slashCommands ?? [], (command) =>
      command.startsWith("/") ? command : `/${command}`,
    ),
  );
  if (commands.size > 0) {
    for (const match of text.matchAll(SLASH_REFERENCE_RE)) {
      if (match.index === undefined || !commands.has(match[2])) continue;
      const from = match.index + match[1].length;
      const to = from + match[2].length;
      if (overlaps(ranges, from, to)) continue;
      ranges.push({
        from,
        to,
        token: { kind: "slash", command: match[2] },
      });
    }
  }

  return ranges.sort((left, right) => left.from - right.from);
}

export interface TrackedReferences {
  planRefs: PlanReference[];
  workRefs: WorkReference[];
  sessionRefs: SessionReference[];
}

export function extractTrackedReferences(text: string): TrackedReferences {
  const planRefs: PlanReference[] = [];
  const workRefs: WorkReference[] = [];
  const sessionRefs: SessionReference[] = [];
  const seenPlans = new Set<string>();
  const seenWorks = new Set<string>();
  const seenSessions = new Set<string>();

  for (const { token } of parseReferenceTokens(text)) {
    if (token.kind === "plan" && !seenPlans.has(token.planId)) {
      seenPlans.add(token.planId);
      const { kind: _, ...reference } = token;
      planRefs.push(reference);
    } else if (token.kind === "work" && !seenWorks.has(token.workId)) {
      seenWorks.add(token.workId);
      const { kind: _, ...reference } = token;
      workRefs.push(reference);
    } else if (
      token.kind === "session" &&
      !seenSessions.has(token.sessionId)
    ) {
      seenSessions.add(token.sessionId);
      const { kind: _, ...reference } = token;
      sessionRefs.push(reference);
    }
  }

  return { planRefs, workRefs, sessionRefs };
}
