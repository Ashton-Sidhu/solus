import type { HostOperatingSystem } from "./types";

/**
 * A host named in a prompt or a reply, as a
 * Markdown link:
 *
 *   [studio-mini](host://ref?serverId=h1&route=Tailscale&system=linux&address=http%3A%2F%2F100.88.12.4%3A4317&state=unreachable)
 *
 * A client draws it as a host chip that opens the host's page. The server id is
 * the identity. The other fields are what the client knew when the link was
 * written: an agent reads them from the link, with no lookup, and a reader
 * sees them when the host is not one of theirs. An agent that names the host
 * in its reply copies the link.
 */
export interface HostReference {
  serverId: string;
  /** The host's name when the link was written. */
  label: string;
  /** How the client reached the host, in words: "Tailscale", "Solus Cloud". */
  route?: string;
  system?: HostOperatingSystem;
  /** Where the host answered. */
  address?: string;
  /** What the host was doing: "idle", "unreachable". */
  state?: string;
}

function escapeLabel(label: string): string {
  return label.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function unescapeLabel(label: string): string {
  return label.replaceAll("\\[", "[").replaceAll("\\]", "]");
}

function isSystem(value: string | null): value is HostOperatingSystem {
  return value === "macos" || value === "windows" || value === "linux";
}

export function hostReferenceMarkdown(host: HostReference): string {
  const params = new URLSearchParams({ serverId: host.serverId });
  if (host.route) params.set("route", host.route);
  if (host.system) params.set("system", host.system);
  if (host.address) params.set("address", host.address);
  if (host.state) params.set("state", host.state);
  return `[${escapeLabel(host.label)}](host://ref?${params})`;
}

/** The host a `host://` link names, or null when the link has no server id. */
export function parseHostHref(href: string, label: string): HostReference | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "host:") return null;
  const serverId = url.searchParams.get("serverId")?.trim();
  if (!serverId) return null;
  const host: HostReference = { serverId, label: unescapeLabel(label) };
  const route = url.searchParams.get("route");
  const system = url.searchParams.get("system");
  const address = url.searchParams.get("address");
  const state = url.searchParams.get("state");
  if (route) host.route = route;
  if (isSystem(system)) host.system = system;
  if (address) host.address = address;
  if (state) host.state = state;
  return host;
}

/** `[label](host://ref?query)`; the label keeps its escaped brackets. */
const HOST_LINK_SOURCE = String.raw`\[((?:\\.|[^\]\\\n])*)\]\((host:\/\/ref\?[^)\s]*)\)`;

/** Every host the text names, the first link of each, in text order. */
export function hostsNamedIn(text: string): HostReference[] {
  const hosts: HostReference[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(HOST_LINK_SOURCE, "g"))) {
    const host = parseHostHref(match[2]!, match[1]!);
    if (!host || seen.has(host.serverId)) continue;
    seen.add(host.serverId);
    hosts.push(host);
  }
  return hosts;
}

/**
 * What an agent needs to act on the hosts a prompt names: one block for each
 * host, for a client to append after the typed text, as it does for a
 * referenced session. Empty when the prompt names no host. The link says what
 * the host is; this says what the agent can do with it. `isRunHost` answers
 * whether a host is the one the session runs on, when the client knows.
 */
export function hostReferenceContext(text: string, isRunHost?: (host: HostReference) => boolean): string {
  return hostsNamedIn(text)
    .map((host) => {
      const startWork = `give host "${host.serverId}" to a session you start with start_sessions`;
      const whatToDo = !isRunHost
        ? `To run work on it, ${startWork}. The host you run on needs no host there.`
        : isRunHost(host)
          ? "It is the host you run on: a session you start with start_sessions runs on it with no host."
          : `It is not the host you run on. To run work on it, ${startWork}.`;
      return `[Referenced Host: "${host.label}" (host: ${host.serverId})]\nThe user means this Solus host. ${whatToDo}`;
    })
    .join("\n\n");
}
