import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson, type SolusToolContext } from './solus-server'

/**
 * Gmail as a Solus MCP server (docs/plans/mcp-integrations.md §13.6). The
 * tools are the ones agents use most — search, read a message or a thread,
 * labels, send, draft, and trash — over the Gmail API v1. A result carries
 * decoded plain text, not Gmail's base64url MIME parts, so an agent reads
 * mail without decoding it.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** `gmail.modify` reads, labels, drafts, and sends. It cannot delete for good, so delete is trash. */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'] as const

/** A message body is cut to this many characters; a thread cuts each message shorter. */
const MESSAGE_BODY_MAX_CHARS = 20_000
const THREAD_BODY_MAX_CHARS = 4_000

const SEARCH_HEADERS = ['From', 'To', 'Subject', 'Date'] as const
const READ_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID'] as const

const messageId = z.string().min(1).describe('A Gmail message id from search_messages or read_thread.')

const headerSchema = z.object({ name: z.string(), value: z.string() })

/** One MIME part as Gmail returns it; `body.data` is base64url, and a large attachment has only `attachmentId`. */
const partSchema = z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(headerSchema).optional(),
  body: z.object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
  get parts() {
    return z.array(partSchema).optional()
  },
})
type Part = z.output<typeof partSchema>

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  payload: partSchema.optional(),
})
type Message = z.output<typeof messageSchema>

const listSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
})

const threadSchema = z.object({ id: z.string(), messages: z.array(messageSchema).optional() })

type Attachment = { filename: string, mimeType: string, size: number, attachmentId: string }

/** One header of a message, or null. Gmail's header names vary in case. */
function headerValue(part: Part | undefined, name: string): string | null {
  return part?.headers?.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())?.value ?? null
}

/** The named headers of a message, by the names asked for. */
function headersOf(part: Part | undefined, names: readonly string[]) {
  return Object.fromEntries(names.map((name) => [name, headerValue(part, name)]))
}

/** Every part of a message, depth first: Gmail nests multipart/alternative inside multipart/mixed. */
function flatParts(part: Part | undefined): Part[] {
  if (!part) return []
  return [part, ...(part.parts ?? []).flatMap(flatParts)]
}

function decoded(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

/** HTML as readable text: blocks become lines, tags go, and the common entities are decoded. */
function htmlText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The text of a body part that is not an attachment, of one media type. */
function bodyOf(parts: Part[], mimeType: string): string | null {
  const texts = parts.filter((part) => part.mimeType === mimeType && !part.filename && part.body?.data).map((part) => decoded(part.body?.data ?? ''))
  return texts.length > 0 ? texts.join('\n') : null
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text
}

/** One message as an agent reads it: headers, plain text (HTML stripped when there is no plain part), and attachments by name only. */
function readable(message: Message, bodyMaxChars: number) {
  const parts = flatParts(message.payload)
  const html = bodyOf(parts, 'text/html')
  const body = bodyOf(parts, 'text/plain') ?? (html === null ? '' : htmlText(html))
  const attachments: Attachment[] = parts
    .filter((part) => part.filename && part.body?.attachmentId)
    .map((part) => ({ filename: part.filename ?? '', mimeType: part.mimeType ?? '', size: part.body?.size ?? 0, attachmentId: part.body?.attachmentId ?? '' }))
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    headers: headersOf(message.payload, READ_HEADERS),
    body: cut(body, bodyMaxChars),
    attachments,
  }
}

async function getMessage(fetch: SolusToolContext['fetch'], id: string, query: string): Promise<Message> {
  const message = messageSchema.safeParse(await vendorJson(await fetch(`${API}/messages/${encodeURIComponent(id)}?${query}`)))
  if (!message.success) throw new Error(`Gmail answered with a message Solus could not read: ${id}.`)
  return message.data
}

function metadataQuery(headers: readonly string[]): string {
  return new URLSearchParams([['format', 'metadata'], ...headers.map((name) => ['metadataHeaders', name])]).toString()
}

/** A header value on one line, so a value cannot add a header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

/**
 * A subject as RFC 2047 encoded words when it is not plain ASCII. Each word
 * holds at most 45 bytes of UTF-8, so it stays inside the 75-character limit,
 * and whole characters, so no word splits one.
 */
function encodedSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject
  const words: string[] = []
  let chunk = ''
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character) > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += character
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ')
}

const composeFields = {
  to: z.array(z.email()).min(1).describe('Recipient email addresses.'),
  cc: z.array(z.email()).optional(),
  bcc: z.array(z.email()).optional(),
  subject: z.string().optional().describe('The subject. A reply without one uses the original subject; a reply gets `Re:` before it.'),
  body: z.string().describe('The message as plain text.'),
  inReplyTo: z.string().min(1).optional().describe('To reply in a thread: the Gmail message id being answered. Solus sets In-Reply-To and References from it.'),
  threadId: z.string().min(1).optional().describe('The thread to put the message in. A reply uses the thread of `inReplyTo` when this is not given.'),
}
const composeSchema = z.object(composeFields)

/** The message as base64url RFC 2822, and the thread it goes in. A reply reads the answered message for its headers. */
async function composed(input: z.output<typeof composeSchema>, fetch: SolusToolContext['fetch']): Promise<{ raw: string, threadId?: string }> {
  const lines = [`To: ${input.to.join(', ')}`]
  if (input.cc?.length) lines.push(`Cc: ${input.cc.join(', ')}`)
  // Gmail sends to Bcc addresses and removes the header from what recipients get.
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.join(', ')}`)
  let subject = input.subject ?? ''
  let threadId = input.threadId
  if (input.inReplyTo) {
    const original = await getMessage(fetch, input.inReplyTo, metadataQuery(['Subject', 'Message-ID', 'References']))
    subject = input.subject ?? headerValue(original.payload, 'Subject') ?? ''
    if (!/^re:/i.test(subject)) subject = `Re: ${subject}`
    threadId ??= original.threadId
    const answered = headerValue(original.payload, 'Message-ID')
    const references = headerValue(original.payload, 'References')
    if (answered) {
      lines.push(`In-Reply-To: ${oneLine(answered)}`)
      lines.push(`References: ${oneLine(references ? `${references} ${answered}` : answered)}`)
    }
  }
  lines.push(
    `Subject: ${encodedSubject(oneLine(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    // Base64 lines stay under the 76-character MIME limit.
    ...(Buffer.from(input.body).toString('base64').match(/.{1,76}/g) ?? []),
  )
  const raw = Buffer.from(lines.join('\r\n')).toString('base64url')
  return threadId ? { raw, threadId } : { raw }
}

export const gmailServer = new GoogleSolusServer({
  id: 'gmail',
  name: 'Gmail',
  description: 'Search, read, label, draft, and send email in Gmail.',
  domain: 'mail.google.com',
  icon: 'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico',
  categories: ['communication'],
  hosts: ['gmail.googleapis.com'],
  scopes: GMAIL_SCOPES,
  tools: [
    solusTool({
      name: 'search_messages',
      description: 'Find messages with Gmail search, newest first, with each one\'s sender, recipients, subject, date, snippet, and labels.',
      input: z.object({
        query: z.string().default('').describe('Gmail search, as in the Gmail search box: `from:ann@example.com`, `is:unread`, `newer_than:7d`, `label:work`, `subject:invoice`, `has:attachment`. Empty finds all mail.'),
        maxResults: z.number().int().min(1).max(50).default(20),
        pageToken: z.string().optional().describe('The nextPageToken of an earlier search, for the next page.'),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const params = new URLSearchParams({ maxResults: String(input.maxResults), fields: 'messages(id),nextPageToken,resultSizeEstimate' })
        if (input.query) params.set('q', input.query)
        if (input.pageToken) params.set('pageToken', input.pageToken)
        const list = listSchema.safeParse(await vendorJson(await fetch(`${API}/messages?${params}`)))
        if (!list.success) throw new Error('Gmail answered with a list Solus could not read.')
        // The list has only ids; each message's headers need their own call.
        const query = `${metadataQuery(SEARCH_HEADERS)}&fields=id,threadId,labelIds,snippet,payload/headers`
        const messages = await Promise.all((list.data.messages ?? []).map((ref) => getMessage(fetch, ref.id, query)))
        return {
          messages: messages.map((message) => ({
            id: message.id,
            threadId: message.threadId,
            snippet: message.snippet ?? '',
            labelIds: message.labelIds ?? [],
            headers: headersOf(message.payload, SEARCH_HEADERS),
          })),
          nextPageToken: list.data.nextPageToken ?? null,
          resultSizeEstimate: list.data.resultSizeEstimate ?? 0,
        }
      },
    }),
    solusTool({
      name: 'read_message',
      description: 'One message in full: headers, the body as plain text, and its attachments by name, type, and size. Attachments are not downloaded.',
      input: z.object({ messageId }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => readable(await getMessage(fetch, input.messageId, 'format=full'), MESSAGE_BODY_MAX_CHARS),
    }),
    solusTool({
      name: 'read_thread',
      description: `Every message in a thread, oldest first, as read_message gives them. Each body is cut at ${THREAD_BODY_MAX_CHARS} characters; use read_message for a whole one.`,
      input: z.object({ threadId: z.string().min(1).describe('A thread id from search_messages.') }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const thread = threadSchema.safeParse(await vendorJson(await fetch(`${API}/threads/${encodeURIComponent(input.threadId)}?format=full`)))
        if (!thread.success) throw new Error('Gmail answered with a thread Solus could not read.')
        return { id: thread.data.id, messages: (thread.data.messages ?? []).map((message) => readable(message, THREAD_BODY_MAX_CHARS)) }
      },
    }),
    solusTool({
      name: 'list_labels',
      description: 'The user\'s labels, system and their own, with the ids modify_labels takes.',
      input: z.object({}),
      readOnly: true,
      destructive: false,
      run: async (_input, { fetch }) => vendorJson(await fetch(`${API}/labels?fields=labels(id,name,type)`)),
    }),
    solusTool({
      name: 'send_message',
      description: 'Send an email as the user. It cannot be unsent. Give inReplyTo to reply in its thread.',
      input: composeSchema,
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${API}/messages/send?fields=id,threadId,labelIds`, { method: 'POST', body: JSON.stringify(await composed(input, fetch)) })),
    }),
    solusTool({
      name: 'create_draft',
      description: 'Save an email as a draft for the user to review and send. Give inReplyTo to draft a reply in its thread.',
      input: composeSchema,
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${API}/drafts?fields=id,message(id,threadId)`, { method: 'POST', body: JSON.stringify({ message: await composed(input, fetch) }) })),
    }),
    solusTool({
      name: 'modify_labels',
      description: 'Add and remove labels on one or more messages. Remove `UNREAD` to mark read, add it to mark unread; remove `INBOX` to archive; add `STARRED` to star.',
      input: z.object({
        messageIds: z.array(z.string().min(1)).min(1).max(1000).describe('Gmail message ids.'),
        addLabelIds: z.array(z.string().min(1)).default([]).describe('Label ids from list_labels, such as STARRED, IMPORTANT, or a user label\'s id.'),
        removeLabelIds: z.array(z.string().min(1)).default([]).describe('Label ids to remove, such as UNREAD or INBOX.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        // batchModify answers with an empty body.
        await vendorJson(await fetch(`${API}/messages/batchModify`, {
          method: 'POST',
          body: JSON.stringify({ ids: input.messageIds, addLabelIds: input.addLabelIds, removeLabelIds: input.removeLabelIds }),
        }))
        return { modified: input.messageIds, added: input.addLabelIds, removed: input.removeLabelIds }
      },
    }),
    solusTool({
      name: 'trash_message',
      description: 'Move a message to the trash. Gmail deletes it for good after 30 days.',
      input: z.object({ messageId }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${API}/messages/${encodeURIComponent(input.messageId)}/trash?fields=id,threadId,labelIds`, { method: 'POST' })),
    }),
  ],
})
