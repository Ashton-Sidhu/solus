import type { ConfigFileKind, FoundServer, FoundUnsupportedReason } from '../integration-types'
import { commandLineText } from './command-server'
import type { FoundPortPlace } from './local-servers'

/**
 * The words for a found server (docs/plans/mcp-first-class.md §8.6), one set
 * for the host, desktop and web, and mobile, so each surface says the same
 * thing about the same server.
 */

const FILE_LABELS = {
  'mcp-json': 'Project .mcp.json',
  'claude-json': 'Claude Code',
  'codex-config': 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  'claude-desktop': 'Claude Desktop',
} satisfies Record<ConfigFileKind, string>

/** The tool that keeps a config file. */
export function configFileLabel(file: ConfigFileKind): string {
  return FILE_LABELS[file]
}

/** Why a found server cannot be added, as one sentence. */
export function foundUnsupportedText(reason: FoundUnsupportedReason): string {
  switch (reason) {
    case 'sse': return 'It uses the HTTP+SSE transport, which MCP deprecated.'
    case 'expansion': return 'It uses ${…}, and Solus expands nothing. Write the value itself in the file, or add the server by hand.'
    case 'not-allowed': return 'Only an administrator of this host can add a command.'
    case 'invalid': return 'Solus cannot read this entry as an MCP server.'
  }
}

/** What the row shows under the name: the command line, as an installed command reads, or the URL. */
export function foundTargetText(server: Pick<FoundServer, 'transport'>): string {
  const transport = server.transport
  if (!transport) return ''
  return transport.kind === 'stdio' ? commandLineText(transport) : transport.url
}

/**
 * Where a found server is, as one line: its files, "Claude Code (~/.claude.json),
 * Cursor (.cursor/mcp.json)", and the port it answered on (§9.2).
 */
export function foundPlacesText(server: Pick<FoundServer, 'foundIn'>, hostLabel = 'this host'): string {
  return server.foundIn.map((place) => place.kind === 'port' ? portPlaceText(place, hostLabel) : `${configFileLabel(place.file)} (${place.path})`).join(', ')
}

/** A running local server's place: "Port 8000 on studio · node · main". The port and the process are the host's. */
export function portPlaceText(place: FoundPortPlace, hostLabel = 'this host'): string {
  return [`Port ${place.port} on ${hostLabel}`, place.processName, place.checkout].filter(Boolean).join(' · ')
}

/** The port place of a found server, when it runs on the host's loopback. */
export function foundPortOf(server: Pick<FoundServer, 'foundIn'>): FoundPortPlace | null {
  return server.foundIn.find((place): place is FoundPortPlace => place.kind === 'port') ?? null
}

/**
 * What a running local server said about itself, and that Solus did not check
 * it (§9.2): any program on the host can answer on a port, so the person reads
 * the port and the process before they add it.
 */
export function portIdentityText(place: FoundPortPlace): string {
  const info = place.serverInfo
  const said = info ? `It says it is ${info.title ?? info.name}${info.version ? ` ${info.version}` : ''}.` : 'It answered as an MCP server but did not say its name.'
  return `${said} Solus did not verify this: any program on this host can answer on a port.`
}

/** The short state of an installed server on the host's loopback that does not run now (§9.3). Neutral, never an error. */
export const NOT_RUNNING_LABEL = 'Not running'

/** Why an installed server on the host's loopback shows no tools now (§9.3). */
export function notRunningText(name: string, hostLabel = 'this host'): string {
  return `${name} is not running on ${hostLabel}. Start it, and its tools show here.`
}

/** The state of a found server in a few words, for the row's trailing text or its screen-reader label. */
export function foundStateText(server: Pick<FoundServer, 'state' | 'unsupported'>): string {
  switch (server.state) {
    case 'new': return 'Not added'
    case 'added': return 'Added'
    case 'changed': return 'Changed in the file'
    case 'unsupported': return server.unsupported === 'not-allowed' ? 'Administrators only' : 'Not supported'
  }
}

/** The label of an installed server that joins only one project's runs (§8.4), on every client's row. */
export function projectOnlyLabel(projectName: string): string {
  return `Only in ${projectName}`
}

/** The warning on a server that only a repository's files hold (§8.6). */
export function projectCommandWarning(projectName: string): string {
  return `This command comes from a file in the repository ${projectName}. Read it before you add it.`
}

/** What an add does with the file's plain values, or null when it has none to copy. */
export function fileValuesText(server: Pick<FoundServer, 'transport' | 'valuesInFile'>): string | null {
  const transport = server.transport
  if (!transport || server.valuesInFile.length === 0) return null
  if (transport.kind === 'http') return 'Use the Authorization header in the file as your key'
  if (transport.kind !== 'stdio') return null
  // A command takes the file's values only when the file gives one for each name (§8.3).
  if (!transport.envNames.every((name) => server.valuesInFile.includes(name))) return null
  return `Use the values of ${transport.envNames.join(', ')} in the file`
}

/** The empty state of the view (§8.6, §9.2). */
export const NO_FOUND_SERVERS_TEXT = 'No MCP servers were found in the config files of this host or running on it.'

/** Why the view shows no running local server (§9.1): the host could not list its listeners. */
export function portScanUnavailableText(reason: string): string {
  return `Solus cannot look for MCP servers that run on this host. ${reason}`
}
