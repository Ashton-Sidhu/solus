import { z } from 'zod'
import { driveApi, googleAnswer } from './google-api'

const DOC_MIME_TYPE = 'application/vnd.google-apps.document'
/** Everything Solus needs to address, order, and version-guard a doc. */
const FILE_FIELDS = 'id,name,modifiedTime,version,webViewLink,mimeType'

export interface DriveDoc {
  docId: string
  docUrl: string
}

/** The answer's data; a refusal names the action and Google's status and body. */
async function driveCall<T>(action: string, call: Promise<{ data: T }>): Promise<T> {
  const answer = await googleAnswer(call)
  if (answer.kind === 'answered') return answer.data
  if (answer.kind === 'unanswered') throw answer.error
  throw new Error(`${action} failed (${answer.status}): ${answer.body}`)
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
  const created = await driveCall('Drive create', driveApi(accessToken).files.create({ requestBody: fields, fields: 'id' }))
  const data = z.object({ id: z.string().min(1) }).parse(created)
  return { docId: data.id, docUrl: docUrlFor(data.id) }
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

const fileListSchema = z.object({ files: z.array(fileSchema) })

export async function fileMetadata(accessToken: string, fileId: string): Promise<DriveFile> {
  return fileSchema.parse(await driveCall('Drive request', driveApi(accessToken).files.get({ fileId, fields: FILE_FIELDS })))
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
  const found = await driveCall('Drive request', driveApi(accessToken).files.list({
    q: clauses.join(' and '),
    fields: `files(${FILE_FIELDS})`,
    pageSize: options.limit ?? 20,
    orderBy: 'modifiedTime desc',
  }))
  return fileListSchema.parse(found).files
}

export async function listFolders(accessToken: string, limit = 100): Promise<DriveFile[]> {
  const found = await driveCall('Drive request', driveApi(accessToken).files.list({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: `files(${FILE_FIELDS})`,
    pageSize: limit,
    orderBy: 'name',
  }))
  return fileListSchema.parse(found).files
}

export async function renameFile(accessToken: string, fileId: string, title: string): Promise<DriveFile> {
  return fileSchema.parse(await driveCall('Drive rename', driveApi(accessToken).files.update({ fileId, fields: FILE_FIELDS, requestBody: { name: title } })))
}
