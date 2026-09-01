import { z } from 'zod'

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const DOC_MIME_TYPE = 'application/vnd.google-apps.document'
/** Everything Solus needs to address, order, and version-guard a doc. */
const FILE_FIELDS = 'id,name,modifiedTime,version,webViewLink,mimeType'

export interface DriveDoc {
  docId: string
  docUrl: string
}


/** The metadata part of a Drive multipart upload. A file created at the root
 *  states no parent rather than an empty list. */
interface DriveFileMetadata {
  name: string
  mimeType: string
  parents?: string[]
}

export async function uploadMarkdownAsDoc(
  accessToken: string,
  title: string,
  markdown: string,
  parentId?: string,
): Promise<DriveDoc> {
  return uploadContentAsDoc(accessToken, title, markdown, 'text/markdown', parentId)
}

export async function uploadHtmlAsDoc(
  accessToken: string,
  title: string,
  html: string,
  parentId?: string,
): Promise<DriveDoc> {
  return uploadContentAsDoc(accessToken, title, html, 'text/html', parentId)
}

async function uploadContentAsDoc(
  accessToken: string,
  title: string,
  content: string,
  contentType: 'text/markdown' | 'text/html',
  parentId?: string,
): Promise<DriveDoc> {
  const boundary = `solus_boundary_${Date.now()}`
  const fields: DriveFileMetadata = {
    name: title,
    mimeType: DOC_MIME_TYPE,
  }
  if (parentId && parentId !== 'root') fields.parents = [parentId]
  const metadata = JSON.stringify(fields)
  const contentBytes = Buffer.from(content, 'utf-8')
  const metadataBytes = Buffer.from(metadata, 'utf-8')

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    metadataBytes,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${contentType}; charset=UTF-8\r\n\r\n`),
    contentBytes,
    Buffer.from(`\r\n--${boundary}--`),
  ])

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })

  const responseBody = await res.text()
  if (res.status !== 200) throw new Error(`Drive upload failed (${res.status}): ${responseBody}`)

  const data = z.object({ id: z.string().min(1) }).parse(JSON.parse(responseBody))
  return {
    docId: data.id,
    docUrl: docUrlFor(data.id),
  }
}

export function docUrlFor(fileId: string): string {
  return `https://docs.google.com/document/d/${fileId}/edit`
}

const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  modifiedTime: z.string().optional(),
  /** A counter Drive raises on every change. Solus's concurrency token — Drive
   *  v3 has no write precondition, so a publish compares this before writing. */
  version: z.string().optional(),
  webViewLink: z.string().optional(),
  mimeType: z.string().optional(),
})

export type DriveFile = z.infer<typeof fileSchema>

async function driveJson<T extends z.ZodType>(accessToken: string, url: string, schema: T): Promise<z.infer<T>> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Drive request failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  return schema.parse(await res.json())
}

export async function fileMetadata(accessToken: string, fileId: string): Promise<DriveFile> {
  return driveJson(accessToken, `${FILES_URL}/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, fileSchema)
}

/**
 * Docs export to markdown natively, so a read needs no conversion of ours.
 * A file Solus did not create needs the `drive.readonly` scope.
 */
export async function exportDocMarkdown(accessToken: string, fileId: string): Promise<string> {
  const res = await fetch(
    `${FILES_URL}/${encodeURIComponent(fileId)}/export?mimeType=text%2Fmarkdown`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error(`Drive export failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  return res.text()
}

export interface DriveListOptions {
  query?: string
  folderId?: string
  limit?: number
}

export async function listDocs(
  accessToken: string,
  options: DriveListOptions = {},
): Promise<DriveFile[]> {
  const clauses = [`mimeType = '${DOC_MIME_TYPE}'`, 'trashed = false']
  // Drive query literals are single-quoted; an unescaped quote makes the whole
  // query invalid rather than returning nothing.
  if (options.query) clauses.push(`fullText contains '${options.query.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`)
  if (options.folderId && options.folderId !== 'root') clauses.push(`'${options.folderId}' in parents`)
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: `files(${FILE_FIELDS})`,
    pageSize: String(options.limit ?? 20),
    orderBy: 'modifiedTime desc',
  })
  const found = await driveJson(accessToken, `${FILES_URL}?${params}`, z.object({ files: z.array(fileSchema) }))
  return found.files
}

export async function listFolders(accessToken: string, limit = 100): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: `files(${FILE_FIELDS})`,
    pageSize: String(limit),
    orderBy: 'name',
  })
  const found = await driveJson(accessToken, `${FILES_URL}?${params}`, z.object({ files: z.array(fileSchema) }))
  return found.files
}

/**
 * Replaces the body of a doc Solus already created, in place. The previous
 * behavior — a new doc per upload — left a trail of copies and no link to
 * update, which is exactly what `WorkExternalLink` exists to end.
 */
export async function updateDocContent(
  accessToken: string,
  fileId: string,
  content: string,
  contentType: 'text/markdown' | 'text/html',
  title?: string,
): Promise<DriveFile> {
  const boundary = `solus_boundary_${Date.now()}`
  const metadata = JSON.stringify(title ? { name: title } : {})
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(metadata, 'utf-8'),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${contentType}; charset=UTF-8\r\n\r\n`),
    Buffer.from(content, 'utf-8'),
    Buffer.from(`\r\n--${boundary}--`),
  ])

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${FILE_FIELDS}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )
  const responseBody = await res.text()
  if (!res.ok) throw new Error(`Drive update failed (${res.status}): ${responseBody}`)
  return fileSchema.parse(JSON.parse(responseBody))
}
