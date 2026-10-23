import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson, vendorText } from './solus-server'

/**
 * Google Drive as a Solus MCP server (docs/plans/mcp-integrations.md §13.6):
 * finding, reading, creating, organizing, and sharing files over the Drive
 * API v3. Every call reaches shared drives too. `drive` is a restricted scope:
 * `drive.file` reaches only files Solus made or the user picked for it.
 */

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

export const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'] as const

const FOLDER = 'application/vnd.google-apps.folder'

/** Google's own types have no bytes to download; each exports to the text format that keeps the most. */
const EXPORT_TYPES = new Map([
  ['application/vnd.google-apps.document', 'text/plain'],
  ['application/vnd.google-apps.spreadsheet', 'text/csv'],
  ['application/vnd.google-apps.presentation', 'text/plain'],
])

/** Uploaded files that read as text, besides every `text/*` type. */
const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/x-sh', 'application/sql', 'image/svg+xml'])

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size'

/** The file id inside a Docs, Sheets, Slides, or Drive link; any other value is taken as an id. */
function fileIdOf(value: string): string {
  return /\/(?:d|folders)\/([\w-]+)/.exec(value)?.[1] ?? /[?&]id=([\w-]+)/.exec(value)?.[1] ?? value
}

const fileId = z.string().min(1).transform(fileIdOf).describe('A file id, or a Google Docs, Sheets, Slides, or Drive link to the file.')

/** A string inside a Drive query: backslashes and single quotes are escaped. */
function queryString(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

const fileTypeSchema = z.object({ name: z.string(), mimeType: z.string() })
const parentsSchema = z.object({ parents: z.array(z.string()).default([]) })

export const googleDriveServer = new GoogleSolusServer({
  id: 'google-drive',
  name: 'Google Drive',
  description: 'Find, read, create, organize, and share files in Google Drive.',
  domain: 'drive.google.com',
  icon: 'https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png',
  categories: ['productivity'],
  hosts: ['www.googleapis.com'],
  scopes: GOOGLE_DRIVE_SCOPES,
  tools: [
    solusTool({
      name: 'search_files',
      description: 'Find files the user can see, newest change first. Trashed files are left out.',
      input: z.object({
        text: z.string().optional().describe('Words to find in the file name or contents.'),
        query: z.string().optional().describe('A Drive query, such as `name contains \'plan\'`, `mimeType = \'application/vnd.google-apps.document\'`, `modifiedTime > \'2026-01-01\'`, or `\'<folderId>\' in parents`. Join terms with `and` or `or`.'),
        pageSize: z.number().int().min(1).max(100).default(25),
        pageToken: z.string().optional().describe('The nextPageToken of an earlier search, for the next page.'),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const terms = ['trashed = false']
        if (input.query) terms.push(`(${input.query})`)
        if (input.text) terms.push(`fullText contains ${queryString(input.text)}`)
        const params = new URLSearchParams({
          q: terms.join(' and '),
          pageSize: String(input.pageSize),
          orderBy: 'modifiedTime desc',
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        })
        if (input.pageToken) params.set('pageToken', input.pageToken)
        return vendorJson(await fetch(`${API}/files?${params}`))
      },
    }),
    solusTool({
      name: 'get_file',
      description: 'A file\'s details: name, type, owners, folders, size, times, and link.',
      input: z.object({ fileId }),
      readOnly: true,
      destructive: false,
      run: async ({ fileId: id }, { fetch }) => {
        const fields = 'id,name,mimeType,description,createdTime,modifiedTime,size,owners(emailAddress,displayName),parents,webViewLink,shared,trashed'
        return vendorJson(await fetch(`${API}/files/${encodeURIComponent(id)}?fields=${fields}&supportsAllDrives=true`))
      },
    }),
    solusTool({
      name: 'read_file',
      description: 'A file\'s contents as text. Google Docs and Slides read as plain text, Google Sheets as CSV of the first sheet, and uploaded text files as they are. Binary files such as PDFs and images are refused.',
      input: z.object({ fileId }),
      readOnly: true,
      destructive: false,
      run: async ({ fileId: id }, { fetch }) => {
        const file = fileTypeSchema.parse(await vendorJson(await fetch(`${API}/files/${encodeURIComponent(id)}?fields=name,mimeType&supportsAllDrives=true`)))
        const exportType = EXPORT_TYPES.get(file.mimeType)
        if (exportType) {
          const text = await vendorText(await fetch(`${API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportType)}`))
          return { id, name: file.name, mimeType: file.mimeType, text }
        }
        if (!file.mimeType.startsWith('text/') && !TEXT_TYPES.has(file.mimeType)) {
          throw new Error(`${file.name} is ${file.mimeType}, which does not read as text.`)
        }
        const text = await vendorText(await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`))
        return { id, name: file.name, mimeType: file.mimeType, text }
      },
    }),
    solusTool({
      name: 'create_file',
      description: 'Create a file from text. With convertTo, Drive makes a Google Doc from the text, or a Google Sheet from CSV.',
      input: z.object({
        name: z.string().min(1),
        content: z.string().describe('The file\'s text.'),
        mimeType: z.string().min(1).default('text/plain').describe('The type of the text, such as text/plain, text/markdown, text/html, or text/csv.'),
        convertTo: z.enum(['document', 'spreadsheet']).optional().describe('Make a Google Doc or Google Sheet instead of a plain file.'),
        parentId: z.string().min(1).transform(fileIdOf).optional().describe('The folder to create it in, by id or link; the user\'s My Drive when not given.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const metadata = {
          name: input.name,
          mimeType: input.convertTo ? `application/vnd.google-apps.${input.convertTo}` : input.mimeType,
          parents: input.parentId ? [input.parentId] : undefined,
        }
        // A sheet converts only from CSV; a doc converts from the given type.
        const mediaType = input.convertTo === 'spreadsheet' ? 'text/csv' : input.mimeType
        const boundary = `solus-${crypto.randomUUID()}`
        const body = [
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          JSON.stringify(metadata),
          `--${boundary}`,
          `Content-Type: ${mediaType}; charset=UTF-8`,
          '',
          input.content,
          `--${boundary}--`,
        ].join('\r\n')
        return vendorJson(await fetch(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,parents,webViewLink`, {
          method: 'POST',
          body,
          contentType: `multipart/related; boundary=${boundary}`,
        }))
      },
    }),
    solusTool({
      name: 'create_folder',
      description: 'Create a folder.',
      input: z.object({
        name: z.string().min(1),
        parentId: z.string().min(1).transform(fileIdOf).optional().describe('The folder to create it in, by id or link; the user\'s My Drive when not given.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${API}/files?supportsAllDrives=true&fields=id,name,parents,webViewLink`, {
        method: 'POST',
        body: JSON.stringify({ name: input.name, mimeType: FOLDER, parents: input.parentId ? [input.parentId] : undefined }),
      })),
    }),
    solusTool({
      name: 'move_file',
      description: 'Move a file or folder into another folder. It leaves every folder it was in, unless fromFolderId names the one to leave.',
      input: z.object({
        fileId,
        toFolderId: z.string().min(1).transform(fileIdOf).describe('The folder to move it into, by id or link.'),
        fromFolderId: z.string().min(1).transform(fileIdOf).optional().describe('The one folder to take it out of.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const url = `${API}/files/${encodeURIComponent(input.fileId)}`
        const from = input.fromFolderId
          ? [input.fromFolderId]
          : parentsSchema.parse(await vendorJson(await fetch(`${url}?fields=parents&supportsAllDrives=true`))).parents
        const params = new URLSearchParams({ addParents: input.toFolderId, removeParents: from.join(','), supportsAllDrives: 'true', fields: 'id,name,parents' })
        return vendorJson(await fetch(`${url}?${params}`, { method: 'PATCH', body: '{}' }))
      },
    }),
    solusTool({
      name: 'rename_file',
      description: 'Give a file or folder a new name.',
      input: z.object({ fileId, name: z.string().min(1) }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${API}/files/${encodeURIComponent(input.fileId)}?supportsAllDrives=true&fields=id,name`, {
        method: 'PATCH',
        body: JSON.stringify({ name: input.name }),
      })),
    }),
    solusTool({
      name: 'share_file',
      description: 'Give one person access to a file or folder. Google emails them unless sendNotificationEmail is false.',
      input: z.object({
        fileId,
        email: z.email().describe('The person to share with.'),
        role: z.enum(['reader', 'commenter', 'writer']).describe('reader views, commenter views and comments, writer edits.'),
        sendNotificationEmail: z.boolean().default(true).describe('Google requires it for an address without a Google account.'),
        message: z.string().optional().describe('A note in the email.'),
      }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => {
        const params = new URLSearchParams({ sendNotificationEmail: String(input.sendNotificationEmail), supportsAllDrives: 'true', fields: 'id,role,emailAddress' })
        // Google refuses a message on a share that sends no email.
        if (input.message && input.sendNotificationEmail) params.set('emailMessage', input.message)
        return vendorJson(await fetch(`${API}/files/${encodeURIComponent(input.fileId)}/permissions?${params}`, {
          method: 'POST',
          body: JSON.stringify({ type: 'user', role: input.role, emailAddress: input.email }),
        }))
      },
    }),
    solusTool({
      name: 'trash_file',
      description: 'Move a file or folder to the trash. Drive empties the trash after 30 days.',
      input: z.object({ fileId }),
      readOnly: false,
      destructive: true,
      run: async ({ fileId: id }, { fetch }) => vendorJson(await fetch(`${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,trashed`, {
        method: 'PATCH',
        body: JSON.stringify({ trashed: true }),
      })),
    }),
  ],
})
