import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson, type SolusToolContext } from './solus-server'

/**
 * Google Meet as a Solus MCP server (docs/plans/mcp-integrations.md §13.6),
 * over the Meet REST API v2. The tools create a meeting, read one, end its
 * call, and read what past calls left: participants, transcripts, and
 * recordings. A transcript reads as `name: text` lines, not Meet's entries.
 */

const API = 'https://meet.googleapis.com/v2'

/** `meetings.space.created` creates and ends meetings this app made; `meetings.space.readonly` reads any meeting the user can see. */
export const GOOGLE_MEET_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.readonly',
] as const

/** A transcript stops at this many characters, so it fits one tool result. */
const TRANSCRIPT_MAX_CHARS = 50_000
/** Participants are read for names up to this many pages; a name not found stays a resource name. */
const PARTICIPANT_MAX_PAGES = 4

const meeting = z.string().min(1).describe('A meeting as a space name (spaces/abc), a meeting code (abc-mnop-xyz), or a link (https://meet.google.com/abc-mnop-xyz).')
const conferenceRecord = z.string().regex(/^(conferenceRecords\/)?[\w-]+$/).describe('A conference record name (conferenceRecords/abc) from list_conference_records.')
const pageSize = z.number().int().min(1).max(100).default(25)
const pageToken = z.string().optional().describe('The nextPageToken of an earlier answer, for the next page.')

/** The space name for a meeting, which Meet also takes as `spaces/{meeting code}`. */
function spaceName(input: string): string {
  const text = input.trim()
  const code = URL.canParse(text) ? new URL(text).pathname.replace(/^\/+|\/+$/g, '') : text.replace(/^spaces\//, '')
  // The pattern keeps the name inside the Meet API path.
  if (!/^[\w-]+$/.test(code)) throw new Error(`Not a meeting: ${input}`)
  return `spaces/${code}`
}

function recordName(input: string): string {
  return input.startsWith('conferenceRecords/') ? input : `conferenceRecords/${input}`
}

function pageParams(size: number, token: string | undefined): URLSearchParams {
  const params = new URLSearchParams({ pageSize: String(size) })
  if (token) params.set('pageToken', token)
  return params
}

const spaceSchema = z.object({
  name: z.string(),
  meetingUri: z.string().optional(),
  meetingCode: z.string().optional(),
  config: z.object({ accessType: z.string().optional() }).optional(),
})

const displayName = z.object({ displayName: z.string().optional() }).optional()
const participantsSchema = z.object({
  participants: z.array(z.object({ name: z.string(), signedinUser: displayName, anonymousUser: displayName, phoneUser: displayName })).optional(),
  nextPageToken: z.string().optional(),
})

const entriesSchema = z.object({
  transcriptEntries: z.array(z.object({ participant: z.string().optional(), text: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
})

/** Display names by participant resource name, for one conference record. */
async function participantNames({ fetch }: SolusToolContext, record: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  let token: string | undefined
  for (let page = 0; page < PARTICIPANT_MAX_PAGES; page++) {
    const answer = participantsSchema.safeParse(await vendorJson(await fetch(`${API}/${record}/participants?${pageParams(250, token)}`)))
    if (!answer.success) break
    for (const participant of answer.data.participants ?? []) {
      const name = participant.signedinUser?.displayName ?? participant.anonymousUser?.displayName ?? participant.phoneUser?.displayName
      if (name) names.set(participant.name, name)
    }
    token = answer.data.nextPageToken
    if (!token) break
  }
  return names
}

export const googleMeetServer = new GoogleSolusServer({
  id: 'google-meet',
  name: 'Google Meet',
  description: 'Meetings, past calls, participants, transcripts, and recordings in Google Meet.',
  domain: 'meet.google.com',
  icon: 'https://ssl.gstatic.com/images/branding/product/2x/meet_2020q4_48dp.png',
  categories: ['communication'],
  hosts: ['meet.googleapis.com'],
  scopes: GOOGLE_MEET_SCOPES,
  tools: [
    solusTool({
      name: 'create_meeting',
      description: 'Create a Google Meet meeting and give its link and code.',
      input: z.object({
        accessType: z.enum(['OPEN', 'TRUSTED', 'RESTRICTED']).optional()
          .describe('Who joins without asking: OPEN anyone with the link, TRUSTED people in the organization and invited people, RESTRICTED only invited people. The account\'s default when not given.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const body = input.accessType ? { config: { accessType: input.accessType } } : {}
        const space = spaceSchema.safeParse(await vendorJson(await fetch(`${API}/spaces`, { method: 'POST', body: JSON.stringify(body) })))
        if (!space.success) throw new Error('Google answered without the new meeting.')
        return { name: space.data.name, meetingUri: space.data.meetingUri ?? null, meetingCode: space.data.meetingCode ?? null }
      },
    }),
    solusTool({
      name: 'get_meeting',
      description: 'One meeting: its link, code, settings, and the call happening in it now, if any.',
      input: z.object({ meeting }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${API}/${spaceName(input.meeting)}`)),
    }),
    solusTool({
      name: 'end_active_conference',
      description: 'End the call happening in a meeting now, for everyone in it. Works only for meetings this connection created.',
      input: z.object({ meeting }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => {
        const name = spaceName(input.meeting)
        await vendorJson(await fetch(`${API}/${name}:endActiveConference`, { method: 'POST', body: '{}' }))
        return { ended: name }
      },
    }),
    solusTool({
      name: 'list_conference_records',
      description: 'Past and current calls (conference records) the user was in, newest first.',
      input: z.object({
        filter: z.string().optional().describe('A Meet filter, such as space.meeting_code = "abc-mnop-xyz" or start_time>="2026-10-01T00:00:00Z".'),
        pageSize,
        pageToken,
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const params = pageParams(input.pageSize, input.pageToken)
        if (input.filter) params.set('filter', input.filter)
        return vendorJson(await fetch(`${API}/conferenceRecords?${params}`))
      },
    }),
    solusTool({
      name: 'list_participants',
      description: 'The people who joined one call, with their names and join and leave times.',
      input: z.object({ conferenceRecord, pageSize, pageToken }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${API}/${recordName(input.conferenceRecord)}/participants?${pageParams(input.pageSize, input.pageToken)}`)),
    }),
    solusTool({
      name: 'list_transcripts',
      description: 'The transcripts of one call, with their state and Google Docs document.',
      input: z.object({ conferenceRecord, pageSize, pageToken }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${API}/${recordName(input.conferenceRecord)}/transcripts?${pageParams(input.pageSize, input.pageToken)}`)),
    }),
    solusTool({
      name: 'read_transcript',
      description: `A transcript's text as "name: text" lines, in spoken order. Stops at ${TRANSCRIPT_MAX_CHARS} characters.`,
      input: z.object({
        transcript: z.string().regex(/^conferenceRecords\/[\w-]+\/transcripts\/[\w-]+$/)
          .describe('A transcript name (conferenceRecords/abc/transcripts/def) from list_transcripts.'),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, context) => {
        // Entries name participants by resource name; the call's participant list gives their display names.
        const names = await participantNames(context, input.transcript.split('/transcripts/')[0])
        const lines: string[] = []
        let length = 0
        let token: string | undefined
        do {
          const answer = entriesSchema.safeParse(await vendorJson(await context.fetch(`${API}/${input.transcript}/entries?${pageParams(100, token)}`)))
          if (!answer.success) throw new Error('Google answered the transcript in a form Solus does not read.')
          for (const entry of answer.data.transcriptEntries ?? []) {
            const speaker = entry.participant ? names.get(entry.participant) ?? entry.participant : 'Unknown'
            const line = `${speaker}: ${entry.text ?? ''}`
            if (length + line.length > TRANSCRIPT_MAX_CHARS) return { text: lines.join('\n'), truncated: true }
            lines.push(line)
            length += line.length + 1
          }
          token = answer.data.nextPageToken
        } while (token)
        return { text: lines.join('\n'), truncated: false }
      },
    }),
    solusTool({
      name: 'list_recordings',
      description: 'The recordings of one call, with the Google Drive file id of each.',
      input: z.object({ conferenceRecord, pageSize, pageToken }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${API}/${recordName(input.conferenceRecord)}/recordings?${pageParams(input.pageSize, input.pageToken)}`)),
    }),
  ],
})
