import { isAbsoluteHostPath } from '@solus/contracts/host-path'
import { integrationEnvNameSchema, integrationLaunchSchema, integrationOAuthClientInputSchema, type FoundPlace, type FoundTransport } from '@solus/contracts/integration-types'

/**
 * One server entry of one config file, as the host read it
 * (docs/plans/mcp-first-class.md §8.2). `secrets` holds the plain values the
 * file gives, by environment name, and a plain `Authorization` header. They
 * stay in the host process: an add copies them into the person's vault entry
 * (§8.3), and no list, record, RPC answer, or log gets them.
 */
export interface ConfigEntry {
  place: FoundPlace
  /** Null when the entry does not read as an MCP server that Solus can run. */
  transport: FoundTransport | null
  /** `${…}` in the command, the arguments, the folder, or the URL: Solus expands nothing. */
  expands: boolean
  /** The names whose plain value the file holds. Names only. */
  valuesInFile: string[]
  secrets: EntrySecrets
  /** The static OAuth client ID the file gives a URL server. Not a secret: an add saves it as the owner's client. */
  oauthClientId?: string
}

export interface EntrySecrets {
  env: Map<string, string>
  authorization?: string
}

export const NO_SECRETS: EntrySecrets = { env: new Map() }

/** A name with the value the file gives it; no value when the file names a variable whose value is elsewhere. */
export type NamedValue = [name: string, value: string | undefined]

const MAX_ENV_NAMES = 64

/** A `${…}` reference, in any of the forms the tools write: `${VAR}`, `${env:VAR}`, `${input:id}`, `${workspaceFolder}`. */
export function expands(text: string): boolean {
  return text.includes('${')
}

/** A value a person could have typed: one with no reference in it. */
function plainValue(value: string | undefined): string | null {
  return value !== undefined && !expands(value) ? value : null
}

/** An entry that names no command or URL Solus can read. */
export function invalidEntry(place: FoundPlace): ConfigEntry {
  return { place, transport: null, expands: false, valuesInFile: [], secrets: NO_SECRETS }
}

export interface StdioFields {
  command: string
  args: string[]
  env: NamedValue[]
  cwd?: string
}

/** A `stdio` entry; its transport is null when its fields are not a command Solus can run (§7.1). */
export function stdioEntry(place: FoundPlace, fields: StdioFields): ConfigEntry {
  const launch = integrationLaunchSchema.safeParse({ command: fields.command, args: fields.args, cwd: fields.cwd || undefined })
  if (!launch.success) return invalidEntry(place)
  const names = fields.env.map(([name]) => name)
  if (names.length > MAX_ENV_NAMES || new Set(names).size !== names.length || !names.every((name) => integrationEnvNameSchema.safeParse(name).success)) return invalidEntry(place)
  const { command, cwd } = launch.data
  // A relative folder would be read against the Solus server's own folder; `~` and an absolute path are the host's.
  if (cwd !== undefined && !expands(cwd) && !cwd.startsWith('~') && !isAbsoluteHostPath(cwd)) return invalidEntry(place)
  const env = new Map<string, string>()
  for (const [name, value] of fields.env) {
    const plain = plainValue(value)
    if (plain !== null) env.set(name, plain)
  }
  const transport: FoundTransport = { kind: 'stdio', command, args: launch.data.args, envNames: names }
  if (cwd !== undefined) transport.cwd = cwd
  return {
    place,
    transport,
    expands: [command, ...launch.data.args, cwd ?? ''].some(expands),
    valuesInFile: [...env.keys()],
    secrets: { env },
  }
}

export interface UrlFields {
  url: string
  /** Header names with the value the file gives each. */
  headers: NamedValue[]
  /** The OAuth client ID the file names for the server, when it has one. */
  clientId?: string
}

/** A server at a URL, over Streamable HTTP or `sse`; its transport is null when the URL is not an http(s) address. */
export function urlEntry(place: FoundPlace, kind: 'http' | 'sse', fields: UrlFields): ConfigEntry {
  const url = fields.url.trim()
  if (url.length > 4096) return invalidEntry(place)
  const headerNames = fields.headers.map(([name]) => name)
  if (expands(url)) {
    const transport: FoundTransport = kind === 'sse' ? { kind, url } : { kind, url, headerNames }
    return { place, transport, expands: true, valuesInFile: [], secrets: NO_SECRETS }
  }
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return invalidEntry(place)
  if (kind === 'sse') return { place, transport: { kind: 'sse', url }, expands: false, valuesInFile: [], secrets: NO_SECRETS }
  // Only a fixed Authorization header is carried, as the person's key; other headers are not (§8.3, §20).
  const authorization = plainValue(fields.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1])
  const secrets: EntrySecrets = authorization === null ? NO_SECRETS : { env: new Map(), authorization }
  const entry: ConfigEntry = { place, transport: { kind: 'http', url, headerNames }, expands: false, valuesInFile: authorization === null ? [] : ['Authorization'], secrets }
  const client = integrationOAuthClientInputSchema.safeParse({ clientId: plainValue(fields.clientId) ?? undefined })
  if (client.success) entry.oauthClientId = client.data.clientId
  return entry
}
