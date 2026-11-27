import { z } from 'zod'
import type { IntegrationAuthChoice, IntegrationEnvValue } from '../integration-types'
import { commandLineText } from './command-server'

/**
 * What a person put in the one field of Add server (docs/integrations.md): an
 * address, a command, or the JSON a server's setup page gives. The JSON is
 * read as the config files of other tools are: `mcpServers` (Claude Code,
 * Cursor, Claude Desktop), `servers` (VS Code), a table of servers by name, or
 * one server entry. It runs no code: `JSON.parse` and plain checks only.
 *
 * A value that holds `${…}` is a reference Solus does not expand, so the name
 * stays and the value does not.
 */
export type ServerSource =
  | { kind: 'empty' }
  | { kind: 'url'; url: string; name?: string; headers: SourceValue[]; clientId?: string }
  | { kind: 'command'; line: string; name?: string; env: SourceValue[]; cwd?: string }
  | { kind: 'invalid'; reason: string }

/** A header or an environment variable the source names, with the value it gives, if any. */
export interface SourceValue {
  name: string
  value?: string
}

/** More text than a server's config can be. */
const MAX_SOURCE_LENGTH = 100_000

/** A value of `env` or `headers`: the tools write a string; a number reads as its text. */
const valueSchema = z.union([z.string(), z.number().transform(String)])
const valueTableSchema = z.record(z.string(), valueSchema.nullable().catch(null)).optional().catch(undefined)

/** One server entry, as the config files write it. Keys Solus does not know are ignored. */
const entrySchema = z.object({
  command: z.string().optional().catch(undefined),
  args: z.array(z.string().catch('')).optional().catch(undefined),
  env: valueTableSchema,
  cwd: z.string().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  // Google Antigravity's older name for `url`.
  serverUrl: z.string().optional().catch(undefined),
  headers: valueTableSchema,
  // Claude Code's static OAuth client (`claude mcp add --client-id`).
  oauth: z.object({ clientId: z.string().optional().catch(undefined) }).optional().catch(undefined),
})
type ServerEntry = z.infer<typeof entrySchema>

/** A table of servers by name; an entry that does not parse is null. */
const entryTableSchema = z.record(z.string(), entrySchema.nullable().catch(null))
const configSchema = z.object({ mcpServers: entryTableSchema.optional().catch(undefined), servers: entryTableSchema.optional().catch(undefined) })

export function readServerSource(text: string): ServerSource {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'empty' }
  if (trimmed.length > MAX_SOURCE_LENGTH) return { kind: 'invalid', reason: 'This is too long for one server.' }
  if (trimmed.startsWith('{')) return readJson(trimmed)
  // Setup pages often show one entry of the table: `"acme": { … }`, without the outer braces.
  if (/^"[^"]+"\s*:\s*\{/.test(trimmed)) return readJson(`{${trimmed.replace(/,\s*$/, '')}}`)
  // Any `scheme://` is meant as an address; the add form says when it is not an http one.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return { kind: 'url', url: trimmed, headers: [] }
  // The start of `http://` or `https://` is an address being typed, not yet a command.
  const lower = trimmed.toLowerCase()
  if ('https://'.startsWith(lower) || 'http://'.startsWith(lower)) return { kind: 'empty' }
  return { kind: 'command', line: trimmed, env: [] }
}

function readJson(text: string): ServerSource {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'invalid', reason: 'This is not valid JSON. Paste the whole block, with its braces.' }
  }
  const single = serverEntry(value)
  if (single) return entrySource(single)
  const table = entryTableSchema.safeParse(value)
  if (!table.success) return { kind: 'invalid', reason: 'This JSON is not a server.' }
  const config = configSchema.parse(value)
  const named = Object.entries(config.mcpServers ?? config.servers ?? table.data)
    .filter((pair): pair is [string, ServerEntry] => pair[1] !== null && namesServer(pair[1]))
  const [first, ...others] = named
  if (!first) return { kind: 'invalid', reason: 'This JSON names no server with a command or a URL.' }
  if (others.length > 0) return { kind: 'invalid', reason: `This JSON has ${named.length} servers. Paste one at a time.` }
  const [name, entry] = first
  const source = entrySource(entry)
  return source.kind === 'url' || source.kind === 'command' ? { ...source, name } : source
}

/** The entry `value` is, when it names a command or a URL. */
function serverEntry(value: unknown): ServerEntry | null {
  const parsed = entrySchema.safeParse(value)
  return parsed.success && namesServer(parsed.data) ? parsed.data : null
}

function namesServer(entry: ServerEntry): boolean {
  return entry.command !== undefined || entry.url !== undefined || entry.serverUrl !== undefined
}

function entrySource(entry: ServerEntry): ServerSource {
  const url = entry.url ?? entry.serverUrl
  const command = entry.command?.trim()
  if (command) {
    const source: ServerSource = { kind: 'command', line: commandLineText({ command, args: entry.args ?? [] }), env: valuesOf(entry.env) }
    const cwd = entry.cwd?.trim()
    if (cwd) source.cwd = cwd
    return source
  }
  if (url !== undefined) {
    if (!/^https?:\/\//i.test(url.trim())) return { kind: 'invalid', reason: 'The server’s URL is not an http or https address.' }
    const source: ServerSource = { kind: 'url', url: url.trim(), headers: valuesOf(entry.headers) }
    const clientId = plain(entry.oauth?.clientId)
    if (clientId) source.clientId = clientId
    return source
  }
  return { kind: 'invalid', reason: 'This server has no command or URL.' }
}

/** The names of a table of values, each with its plain value. */
function valuesOf(table: ServerEntry['env']): SourceValue[] {
  return Object.entries(table ?? {}).map(([name, value]) => {
    const text = plain(value ?? undefined)
    return text === undefined ? { name } : { name, value: text }
  })
}

/** A value with no `${…}` reference in it. */
function plain(value: string | undefined): string | undefined {
  return value?.trim() && !value.includes('${') ? value.trim() : undefined
}

/**
 * What an add sends for an address the field read: the authentication, and
 * the header values to give once the record exists. A static OAuth client goes
 * with Automatic, so it applies only when the host finds OAuth; headers the
 * source names make it a `headers` server.
 */
export function urlSourceAdd(source: Extract<ServerSource, { kind: 'url' }>): { auth?: IntegrationAuthChoice; values: IntegrationEnvValue[] } {
  if (source.headers.length > 0) {
    return {
      auth: { kind: 'headers', names: source.headers.map((header) => header.name) },
      values: source.headers.flatMap((header) => (header.value ? [{ name: header.name, value: header.value }] : [])),
    }
  }
  return source.clientId ? { auth: { kind: 'automatic', client: { clientId: source.clientId } }, values: [] } : { values: [] }
}
