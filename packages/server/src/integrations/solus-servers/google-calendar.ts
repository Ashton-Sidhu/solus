import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson } from './solus-server'

/**
 * Google Calendar as a Solus MCP server (docs/plans/mcp-integrations.md
 * §13.6): Google publishes no usable Calendar MCP server. The tools are the
 * ones agents use most — calendars, events in a range, free and busy times,
 * and creating, changing, and deleting an event — over the Calendar API v3.
 * Both scopes are sensitive, not restricted, so Google's app verification is
 * enough for them.
 */

const API = 'https://www.googleapis.com/calendar/v3'

/** `calendar.events` reads and writes events; `calendar.readonly` lists calendars and free/busy times. */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const

const calendarId = z.string().min(1).default('primary').describe('A calendar id from list_calendars; `primary` is the user\'s own calendar.')
const dateTime = z.string().min(1).describe('An RFC 3339 time with an offset, such as 2026-10-23T09:00:00-04:00.')

const eventTime = z.object({
  dateTime: z.string().optional().describe('RFC 3339 time with an offset, for a timed event.'),
  date: z.string().optional().describe('YYYY-MM-DD, for an all-day event.'),
  timeZone: z.string().optional().describe('An IANA time zone, such as America/New_York.'),
})

const eventFields = {
  summary: z.string().optional().describe('The title.'),
  description: z.string().optional(),
  location: z.string().optional(),
  start: eventTime.optional(),
  end: eventTime.optional(),
  attendees: z.array(z.email()).optional().describe('Email addresses to invite.'),
}

const eventFieldsSchema = z.object(eventFields)

/** The Calendar API's event body: attendees as objects, every other field as given. */
function eventBody(fields: z.output<typeof eventFieldsSchema>): string {
  const { attendees, ...rest } = fields
  if (!attendees) return JSON.stringify(rest)
  return JSON.stringify({ ...rest, attendees: attendees.map((email) => ({ email })) })
}

export const googleCalendarServer = new GoogleSolusServer({
  id: 'google-calendar',
  name: 'Google Calendar',
  description: 'Calendars, events, and free and busy times in Google Calendar.',
  domain: 'calendar.google.com',
  icon: 'https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png',
  categories: ['productivity'],
  hosts: ['www.googleapis.com'],
  scopes: GOOGLE_CALENDAR_SCOPES,
  tools: [
    solusTool({
      name: 'list_calendars',
      description: 'The calendars the user can see, with their ids, names, and time zones.',
      input: z.object({}),
      readOnly: true,
      destructive: false,
      run: async (_input, { fetch }) => vendorJson(await fetch(`${API}/users/me/calendarList?fields=items(id,summary,timeZone,primary,accessRole)`)),
    }),
    solusTool({
      name: 'list_events',
      description: 'Events in one calendar between two times, earliest first. Recurring events are expanded.',
      input: z.object({
        calendarId,
        timeMin: dateTime,
        timeMax: dateTime,
        query: z.string().optional().describe('Words to find in the title, description, location, or attendees.'),
        maxResults: z.number().int().min(1).max(250).default(50),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const params = new URLSearchParams({ timeMin: input.timeMin, timeMax: input.timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(input.maxResults) })
        if (input.query) params.set('q', input.query)
        return vendorJson(await fetch(`${API}/calendars/${encodeURIComponent(input.calendarId)}/events?${params}`))
      },
    }),
    solusTool({
      name: 'find_free_busy',
      description: 'The busy times of one or more calendars between two times, to find a free slot.',
      input: z.object({
        calendarIds: z.array(z.string().min(1)).min(1).default(['primary']),
        timeMin: dateTime,
        timeMax: dateTime,
        timeZone: z.string().optional(),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${API}/freeBusy`, {
        method: 'POST',
        body: JSON.stringify({ timeMin: input.timeMin, timeMax: input.timeMax, timeZone: input.timeZone, items: input.calendarIds.map((id) => ({ id })) }),
      })),
    }),
    solusTool({
      name: 'create_event',
      description: 'Create an event. Give start and end as dateTime for a timed event, or date for an all-day one. Attendees get Google\'s invitation.',
      input: z.object({ calendarId, ...eventFields, summary: z.string().min(1), start: eventTime, end: eventTime }),
      readOnly: false,
      destructive: false,
      run: async ({ calendarId: calendar, ...fields }, { fetch }) =>
        vendorJson(await fetch(`${API}/calendars/${encodeURIComponent(calendar)}/events?sendUpdates=all`, { method: 'POST', body: eventBody(fields) })),
    }),
    solusTool({
      name: 'update_event',
      description: 'Change fields of an event. Fields not given stay as they are.',
      input: z.object({ calendarId, eventId: z.string().min(1), ...eventFields }),
      readOnly: false,
      destructive: false,
      run: async ({ calendarId: calendar, eventId, ...fields }, { fetch }) =>
        vendorJson(await fetch(`${API}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'PATCH', body: eventBody(fields) })),
    }),
    solusTool({
      name: 'delete_event',
      description: 'Delete an event. Attendees get Google\'s cancellation.',
      input: z.object({ calendarId, eventId: z.string().min(1) }),
      readOnly: false,
      destructive: true,
      run: async ({ calendarId: calendar, eventId }, { fetch }) => {
        const response = await fetch(`${API}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'DELETE' })
        if (!response.ok) await vendorJson(response)
        return { deleted: eventId }
      },
    }),
  ],
})
