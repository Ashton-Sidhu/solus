import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson, type SolusToolContext } from './solus-server'

/**
 * Google Contacts as a Solus MCP server (docs/plans/mcp-integrations.md
 * §13.6), over the People API v1. The tools find people three ways — the
 * user's saved contacts, the "other contacts" Gmail keeps for people the user
 * wrote to, and a Google Workspace directory — and read, create, change, and
 * delete saved contacts.
 */

const API = 'https://people.googleapis.com/v1'

/** `contacts` reads and writes saved contacts; the other two only read other contacts and the directory. */
export const GOOGLE_CONTACTS_SCOPES = [
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
] as const

/** The fields every read asks for: enough to know who someone is and how to reach them. */
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,biographies,urls,addresses,birthdays,memberships'
const OTHER_CONTACT_FIELDS = 'names,emailAddresses,phoneNumbers'

// The pattern keeps the name inside the People API path.
const resourceName = z.string().regex(/^people\/[\w-]+$/).describe('A contact\'s resource name, such as people/c123, from a search or list.')
const query = z.string().min(1).describe('Words to match in names, emails, phone numbers, or organizations. Matches start of words.')

const contactFields = {
  givenName: z.string().optional(),
  familyName: z.string().optional(),
  emails: z.array(z.string().min(1)).optional().describe('Email addresses. On update, they replace all the contact\'s emails.'),
  phones: z.array(z.string().min(1)).optional().describe('Phone numbers. On update, they replace all the contact\'s phones.'),
  organization: z.string().optional().describe('The company or organization.'),
  title: z.string().optional().describe('The job title at the organization.'),
  notes: z.string().optional().describe('Free notes about the person.'),
}
const contactFieldsSchema = z.object(contactFields)
type ContactFields = z.output<typeof contactFieldsSchema>

/** The People API's person body, with only the fields a write sets. */
interface PersonBody {
  etag?: string
  names?: { givenName?: string, familyName?: string }[]
  emailAddresses?: { value: string }[]
  phoneNumbers?: { value: string }[]
  organizations?: { name?: string, title?: string }[]
  biographies?: { value: string, contentType: 'TEXT_PLAIN' }[]
}

const existingSchema = z.object({
  etag: z.string(),
  names: z.array(z.object({ givenName: z.string().optional(), familyName: z.string().optional() })).optional(),
  organizations: z.array(z.object({ name: z.string().optional(), title: z.string().optional() })).optional(),
})
type Existing = z.output<typeof existingSchema>

/**
 * The person body for the given fields. A name and an organization are each
 * one People field with two parts, so a part not given keeps the existing value.
 */
function personBody(fields: ContactFields, existing?: Existing): PersonBody {
  const body: PersonBody = {}
  if (fields.givenName !== undefined || fields.familyName !== undefined) {
    const name = existing?.names?.[0]
    body.names = [{ givenName: fields.givenName ?? name?.givenName, familyName: fields.familyName ?? name?.familyName }]
  }
  if (fields.emails) body.emailAddresses = fields.emails.map((value) => ({ value }))
  if (fields.phones) body.phoneNumbers = fields.phones.map((value) => ({ value }))
  if (fields.organization !== undefined || fields.title !== undefined) {
    const organization = existing?.organizations?.[0]
    body.organizations = [{ name: fields.organization ?? organization?.name, title: fields.title ?? organization?.title }]
  }
  if (fields.notes !== undefined) body.biographies = [{ value: fields.notes, contentType: 'TEXT_PLAIN' }]
  return body
}

/** The People fields a body sets, for `updatePersonFields`. */
function setFields(body: PersonBody): string {
  return (['names', 'emailAddresses', 'phoneNumbers', 'organizations', 'biographies'] as const).filter((field) => body[field]).join(',')
}

/**
 * Google asks for one search with an empty query before the first real one,
 * to fill its search cache; without it the first search can return nothing.
 */
async function warmUp({ fetch }: SolusToolContext, path: string, readMask: string): Promise<void> {
  const response = await fetch(`${API}/${path}?${new URLSearchParams({ query: '', readMask })}`)
  await response.body?.cancel().catch(() => undefined)
}

export const googleContactsServer = new GoogleSolusServer({
  id: 'google-contacts',
  name: 'Google Contacts',
  description: 'Saved contacts, other contacts, and the Google Workspace directory in Google Contacts.',
  domain: 'contacts.google.com',
  icon: 'https://ssl.gstatic.com/images/branding/product/2x/contacts_2022_48dp.png',
  categories: ['communication'],
  hosts: ['people.googleapis.com'],
  scopes: GOOGLE_CONTACTS_SCOPES,
  tools: [
    solusTool({
      name: 'search_contacts',
      description: 'Find the user\'s saved contacts by name, email, phone, or organization.',
      input: z.object({ query, pageSize: z.number().int().min(1).max(30).default(10) }),
      readOnly: true,
      destructive: false,
      run: async (input, context) => {
        await warmUp(context, 'people:searchContacts', PERSON_FIELDS)
        const params = new URLSearchParams({ query: input.query, readMask: PERSON_FIELDS, pageSize: String(input.pageSize) })
        return vendorJson(await context.fetch(`${API}/people:searchContacts?${params}`))
      },
    }),
    solusTool({
      name: 'search_other_contacts',
      description: 'Find people the user emailed but never saved as a contact ("other contacts"). Gives names, emails, and phones.',
      input: z.object({ query, pageSize: z.number().int().min(1).max(30).default(10) }),
      readOnly: true,
      destructive: false,
      run: async (input, context) => {
        await warmUp(context, 'otherContacts:search', OTHER_CONTACT_FIELDS)
        const params = new URLSearchParams({ query: input.query, readMask: OTHER_CONTACT_FIELDS, pageSize: String(input.pageSize) })
        return vendorJson(await context.fetch(`${API}/otherContacts:search?${params}`))
      },
    }),
    solusTool({
      name: 'search_directory',
      description: 'Find people in the user\'s Google Workspace organization directory. Works only for Google Workspace accounts, not personal Gmail accounts.',
      input: z.object({ query, pageSize: z.number().int().min(1).max(100).default(20) }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const params = new URLSearchParams({ query: input.query, readMask: PERSON_FIELDS, pageSize: String(input.pageSize) })
        params.append('sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE')
        params.append('sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT')
        return vendorJson(await fetch(`${API}/people:searchDirectoryPeople?${params}`))
      },
    }),
    solusTool({
      name: 'get_contact',
      description: 'One saved contact with all its details.',
      input: z.object({ resourceName }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${API}/${input.resourceName}?personFields=${PERSON_FIELDS}`)),
    }),
    solusTool({
      name: 'list_contacts',
      description: 'The user\'s saved contacts, most recently changed first. Use pageToken from the answer for the next page.',
      input: z.object({
        pageSize: z.number().int().min(1).max(1000).default(100),
        pageToken: z.string().optional(),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const params = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: String(input.pageSize), sortOrder: 'LAST_MODIFIED_DESCENDING' })
        if (input.pageToken) params.set('pageToken', input.pageToken)
        return vendorJson(await fetch(`${API}/people/me/connections?${params}`))
      },
    }),
    solusTool({
      name: 'create_contact',
      description: 'Save a new contact.',
      input: contactFieldsSchema,
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${API}/people:createContact?personFields=${PERSON_FIELDS}`, { method: 'POST', body: JSON.stringify(personBody(input)) })),
    }),
    solusTool({
      name: 'update_contact',
      description: 'Change fields of a saved contact. Fields not given stay as they are; emails and phones, when given, replace the old lists.',
      input: z.object({ resourceName, ...contactFields }),
      readOnly: false,
      destructive: false,
      run: async ({ resourceName: name, ...fields }, { fetch }) => {
        // The update needs the current etag, so Google refuses a change made over someone else's.
        const existing = existingSchema.safeParse(await vendorJson(await fetch(`${API}/${name}?personFields=names,organizations`)))
        if (!existing.success) throw new Error('Google answered the contact without an etag.')
        const body = personBody(fields, existing.data)
        const updatePersonFields = setFields(body)
        if (!updatePersonFields) throw new Error('Give at least one field to change.')
        body.etag = existing.data.etag
        const params = new URLSearchParams({ updatePersonFields, personFields: PERSON_FIELDS })
        return vendorJson(await fetch(`${API}/${name}:updateContact?${params}`, { method: 'PATCH', body: JSON.stringify(body) }))
      },
    }),
    solusTool({
      name: 'delete_contact',
      description: 'Delete a saved contact.',
      input: z.object({ resourceName }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => {
        const response = await fetch(`${API}/${input.resourceName}:deleteContact`, { method: 'DELETE' })
        if (!response.ok) await vendorJson(response)
        return { deleted: input.resourceName }
      },
    }),
  ],
})
