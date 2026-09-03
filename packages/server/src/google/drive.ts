import { z } from 'zod'

const RESUMABLE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'
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

/**
 * An empty Google Doc. The body is written afterwards through the Docs API;
 * Drive's own importers are never given content, because they restyle it.
 */
export async function createEmptyDoc(accessToken: string, title: string, parentId?: string): Promise<DriveDoc> {
  const fields: DriveFileMetadata = { name: title, mimeType: DOC_MIME_TYPE }
  if (parentId && parentId !== 'root') fields.parents = [parentId]
  const res = await fetch(`${FILES_URL}?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  const responseBody = await res.text()
  if (!res.ok) throw new Error(`Drive create failed (${res.status}): ${responseBody}`)
  const data = z.object({ id: z.string().min(1) }).parse(JSON.parse(responseBody))
  return { docId: data.id, docUrl: docUrlFor(data.id) }
}

/**
 * A PNG the Docs API can fetch. The Docs API takes an image only by URL and
 * fetches it once at insertion, so a diagram goes up as a Drive file, is
 * readable by link for the seconds the insert takes, and is deleted right
 * after; the document keeps its own copy.
 *
 * The upload is resumable rather than multipart: a figure drawn for a reader
 * zoomed to 200% runs to tens of megapixels, and multipart stops at 5 MB.
 * The bytes go in one PUT — the point here is the size limit, not recovery.
 */
export async function uploadPng(
  accessToken: string,
  name: string,
  png: Buffer,
  parentId?: string,
): Promise<string> {
  const fields: DriveFileMetadata = { name, mimeType: 'image/png' }
  if (parentId && parentId !== 'root') fields.parents = [parentId]
  const start = await fetch(RESUMABLE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'image/png',
      'X-Upload-Content-Length': String(png.byteLength),
    },
    body: JSON.stringify(fields),
  })
  if (!start.ok) throw new Error(`Drive image upload failed (${start.status}): ${await start.text()}`)
  const uploadUrl = start.headers.get('location')
  if (!uploadUrl) throw new Error('Drive accepted the image upload but named no location to send it to.')

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/png', 'Content-Length': String(png.byteLength) },
    body: new Uint8Array(png),
  })
  const responseBody = await res.text()
  if (!res.ok) throw new Error(`Drive image upload failed (${res.status}): ${responseBody}`)
  return z.object({ id: z.string().min(1) }).parse(JSON.parse(responseBody)).id
}

export async function shareByLink(accessToken: string, fileId: string): Promise<void> {
  const res = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  })
  if (!res.ok) throw new Error(`Drive share failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
}

/** The URL Google's own image fetcher resolves for a link-readable file. */
export function fileContentUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`
}

export async function deleteFile(accessToken: string, fileId: string): Promise<void> {
  const res = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok && res.status !== 404) throw new Error(`Drive delete failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
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

export async function renameFile(accessToken: string, fileId: string, title: string): Promise<DriveFile> {
  const res = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: title }),
  })
  const responseBody = await res.text()
  if (!res.ok) throw new Error(`Drive rename failed (${res.status}): ${responseBody}`)
  return fileSchema.parse(JSON.parse(responseBody))
}
