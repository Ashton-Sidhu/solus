import { integrationHeaderNamesSchema, oauthScopesSchema, type IntegrationAuthChoice, type IntegrationEnvValue } from '../integration-types'

/**
 * The Authentication of a new server at a URL (docs/plans/mcp-add-server.md):
 * the choices in words and the check of what the person typed, so desktop,
 * web, and mobile offer the same choices and refuse the same input.
 */

export type AuthChoiceKind = IntegrationAuthChoice['kind']

export const AUTH_CHOICES: readonly { kind: AuthChoiceKind; label: string; description: string }[] = [
  { kind: 'automatic', label: 'Automatic', description: 'Solus checks the server and uses the sign-in it offers.' },
  { kind: 'oauth', label: 'OAuth', description: 'Each person signs in on the server’s sign-in page.' },
  { kind: 'bearer', label: 'API key', description: 'Each person pastes a key. Solus sends it as a bearer token.' },
  { kind: 'headers', label: 'Headers', description: 'Each person gives a value for each header you name, such as X-API-Key.' },
  { kind: 'none', label: 'None', description: 'The server needs no sign-in.' },
]

/** One header row of the form: the name is on the record, the value is the person's secret. */
export interface HeaderDraft {
  name: string
  value: string
}

/** What the person typed under Authentication. */
export interface AuthChoiceDraft {
  kind: AuthChoiceKind
  clientId: string
  clientSecret: string
  /** Scopes separated by spaces or commas. */
  scopes: string
  headers: readonly HeaderDraft[]
}

export type AuthChoiceField = 'clientId' | 'scopes' | 'headers'

export type AuthChoiceCheck =
  /** `values`: the header values typed with the add, given to the host once the record exists. */
  | { ok: true; auth: IntegrationAuthChoice; values: IntegrationEnvValue[] }
  | { ok: false; field: AuthChoiceField; reason: string }

/**
 * The `auth` a create request carries: none for a plain Automatic, which is
 * what the host does with no `auth`. A host from before Add server refuses the
 * field, so a plain add still works there.
 */
export function requestAuthOf(auth: IntegrationAuthChoice): IntegrationAuthChoice | undefined {
  return auth.kind === 'automatic' && !auth.scopes && !auth.client ? undefined : auth
}

/** True when the choice shows the OAuth fields: OAuth, and Automatic for a server that turns out to use OAuth. */
export function takesOAuthFields(kind: AuthChoiceKind): boolean {
  return kind === 'automatic' || kind === 'oauth'
}

/** The scopes the person typed, or null when they typed none; a refused scope says why. */
export function parseScopes(text: string): { ok: true; scopes: string[] | null } | { ok: false; reason: string } {
  const words = text.split(/[\s,]+/).filter((word) => word.length > 0)
  if (words.length === 0) return { ok: true, scopes: null }
  const parsed = oauthScopesSchema.safeParse([...new Set(words)])
  return parsed.success ? { ok: true, scopes: parsed.data } : { ok: false, reason: parsed.error.issues[0]?.message ?? 'A scope is not valid.' }
}

/** Header names typed as one line, separated by spaces or commas, for the row's editor. */
export function parseHeaderNames(text: string): { ok: true; names: string[] } | { ok: false; reason: string } {
  const words = text.split(/[\s,]+/).filter((word) => word.length > 0)
  if (words.length === 0) return { ok: false, reason: 'Name at least one header.' }
  const parsed = integrationHeaderNamesSchema.safeParse(words)
  return parsed.success ? { ok: true, names: parsed.data } : { ok: false, reason: parsed.error.issues[0]?.message ?? 'A header name is not valid.' }
}

/** The form as the host takes it, or the first field it refuses and why. */
export function checkAuthChoice(draft: AuthChoiceDraft): AuthChoiceCheck {
  switch (draft.kind) {
    case 'bearer':
    case 'none':
      return { ok: true, auth: { kind: draft.kind }, values: [] }
    case 'headers':
      return checkHeaders(draft.headers)
    case 'automatic':
    case 'oauth':
      return checkOAuth(draft.kind, draft)
  }
}

function checkOAuth(kind: 'automatic' | 'oauth', draft: AuthChoiceDraft): AuthChoiceCheck {
  const clientId = draft.clientId.trim()
  if (!clientId && draft.clientSecret) return { ok: false, field: 'clientId', reason: 'Enter the client ID that goes with the secret.' }
  const scopes = parseScopes(draft.scopes)
  if (!scopes.ok) return { ok: false, field: 'scopes', reason: scopes.reason }
  const auth: Extract<IntegrationAuthChoice, { kind: 'automatic' | 'oauth' }> = { kind }
  if (scopes.scopes) auth.scopes = scopes.scopes
  if (clientId) auth.client = draft.clientSecret ? { clientId, clientSecret: draft.clientSecret } : { clientId }
  return { ok: true, auth, values: [] }
}

/** Rows with no name and no value are left out; a value needs a name. A value left empty is given later. */
function checkHeaders(headers: readonly HeaderDraft[]): AuthChoiceCheck {
  const rows = headers.map((header) => ({ name: header.name.trim(), value: header.value })).filter((header) => header.name || header.value)
  if (rows.some((header) => !header.name)) return { ok: false, field: 'headers', reason: 'Give each value a header name.' }
  const names = integrationHeaderNamesSchema.safeParse(rows.map((header) => header.name))
  if (!names.success) return { ok: false, field: 'headers', reason: rows.length === 0 ? 'Name at least one header.' : names.error.issues[0]?.message ?? 'A header name is not valid.' }
  const values = rows.filter((header) => header.value.length > 0)
  return { ok: true, auth: { kind: 'headers', names: names.data }, values }
}
