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

/**
 * The agents of Solus whose CLI loads a file's servers by itself: Claude Code
 * reads its own file and the project `.mcp.json`, Codex reads its own. The
 * other tools' files reach no agent until the person adds the server.
 */
const FILE_AGENTS = {
  'mcp-json': ['Claude'],
  'claude-json': ['Claude'],
  'codex-config': ['Codex'],
  cursor: [],
  vscode: [],
  'claude-desktop': [],
} satisfies Record<ConfigFileKind, Array<'Claude' | 'Codex'>>

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

/**
 * The words of one found server on one host: what the row, the add dialog,
 * and the phone's alert say. The host's name is part of the place of a server
 * on its loopback, so each client names the host it shows (§9.2).
 */
export class FoundServerLabels {
  constructor(private readonly server: FoundServer, private readonly hostLabel: string) {}

  /** What the row shows under the name: the command line, as an installed command reads, or the URL. */
  get target(): string {
    const transport = this.server.transport
    if (!transport) return ''
    return transport.kind === 'stdio' ? commandLineText(transport) : transport.url
  }

  /**
   * Where the server is, as one line: its files, "Claude Code (~/.claude.json),
   * Cursor (.cursor/mcp.json)", and the port it answered on (§9.2).
   */
  get places(): string {
    return this.server.foundIn.map((place) => place.kind === 'port' ? portPlaceText(place, this.hostLabel) : `${configFileLabel(place.file)} (${place.path})`).join(', ')
  }

  /** The port place, when the server runs on the host's loopback. */
  get port(): FoundPortPlace | null {
    return this.server.foundIn.find((place): place is FoundPortPlace => place.kind === 'port') ?? null
  }

  /**
   * What a running local server said about itself, and that Solus did not
   * check it (§9.2): any program on the host can answer on a port, so the
   * person reads the port and the process before they add it. Null for a
   * server of the files only.
   */
  get portIdentity(): string | null {
    const port = this.port
    if (!port) return null
    const info = port.serverInfo
    const said = info ? `It says it is ${info.title ?? info.name}${info.version ? ` ${info.version}` : ''}.` : 'It answered as an MCP server but did not say its name.'
    return `${said} Solus did not verify this: any program on this host can answer on a port.`
  }

  /**
   * Which agents use the server now, from their own files, and what an add
   * changes: the row's answer to "is this not installed already?". Null for a
   * server that Solus already has, and for one it cannot add that no agent uses.
   */
  get reach(): string | null {
    if (this.server.state === 'added' || this.server.state === 'changed') return null
    const agents = new Set(this.server.foundIn.flatMap((place) => place.kind === 'file' && !place.turnedOff ? FILE_AGENTS[place.file] : []))
    const users = agents.size === 2 ? 'Claude and Codex use' : agents.has('Claude') ? 'Claude uses' : agents.has('Codex') ? 'Codex uses' : null
    if (this.server.state === 'unsupported') return users ? `${users} it from its own config file.` : null
    if (agents.size === 2) return 'Claude and Codex use it now, each from its own config file. Add it to manage it in Solus.'
    if (users) return `${users} it now. Add it to use it in ${agents.has('Claude') ? 'Codex' : 'Claude'} too.`
    return 'No agent uses it now. Add it to use it in Claude and Codex.'
  }

  /** The state in a few words, for the row's trailing text or its screen-reader label. */
  get state(): string {
    switch (this.server.state) {
      case 'new': return 'Not added'
      case 'added': return 'Added'
      case 'changed': return 'Changed in the file'
      case 'unsupported': return this.server.unsupported === 'not-allowed' ? 'Administrators only' : 'Not supported'
    }
  }

  /** Why the server cannot be added, or null when it can. */
  get unsupported(): string | null {
    return this.server.state === 'unsupported' && this.server.unsupported ? foundUnsupportedText(this.server.unsupported) : null
  }

  /** What an add does with the file's plain values, or null when it has none to copy. */
  get fileValues(): string | null {
    const { transport, valuesInFile } = this.server
    if (!transport || valuesInFile.length === 0) return null
    if (transport.kind === 'http') return 'Use the Authorization header in the file as your key'
    if (transport.kind !== 'stdio') return null
    // A command takes the file's values only when the file gives one for each name (§8.3).
    if (!transport.envNames.every((name) => valuesInFile.includes(name))) return null
    return `Use the values of ${transport.envNames.join(', ')} in the file`
  }
}

/** A running local server's place: "Port 8000 on studio · node · main". The port and the process are the host's. */
function portPlaceText(place: FoundPortPlace, hostLabel: string): string {
  return [`Port ${place.port} on ${hostLabel}`, place.processName, place.checkout].filter(Boolean).join(' · ')
}

/** The short state of an installed server on the host's loopback that does not run now (§9.3). Neutral, never an error. */
export const NOT_RUNNING_LABEL = 'Not running'

/** Why an installed server on the host's loopback shows no tools now (§9.3). */
export function notRunningText(name: string, hostLabel: string): string {
  return `${name} is not running on ${hostLabel}. Start it, and its tools show here.`
}

/** The label of an installed server that joins only one project's runs (§8.4), on every client's row. */
export function projectOnlyLabel(projectName: string): string {
  return `Only in ${projectName}`
}

/** The warning on a server that only a repository's files hold (§8.6). */
export function projectCommandWarning(projectName: string): string {
  return `This command comes from a file in the repository ${projectName}. Read it before you add it.`
}

/** What the view lists, and that an agent uses only the servers of its own config file (§8.6). */
export function foundSectionText(hostLabel: string, projectName: string | null): string {
  return `MCP servers in the config files of Claude Code, Codex, Cursor, VS Code, and Claude Desktop on ${hostLabel}${projectName ? ` and in ${projectName}` : ''}, and MCP servers that run on it. An agent uses only the servers in its own config file. Add a server to use it in Claude and Codex and to manage its tools here.`
}

/** The empty state of the view (§8.6, §9.2). */
export const NO_FOUND_SERVERS_TEXT = 'No MCP servers were found in the config files of this host or running on it.'

/** Why the view shows no running local server (§9.1): the host could not list its listeners. */
export function portScanUnavailableText(reason: string): string {
  return `Solus cannot look for MCP servers that run on this host. ${reason}`
}
