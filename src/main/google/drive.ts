import { z } from 'zod'

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'

export interface DriveDoc {
  docId: string
  docUrl: string
}

export async function uploadMarkdownAsDoc(
  accessToken: string,
  title: string,
  markdown: string,
): Promise<DriveDoc> {
  return uploadContentAsDoc(accessToken, title, markdown, 'text/markdown')
}

export async function uploadHtmlAsDoc(
  accessToken: string,
  title: string,
  html: string,
): Promise<DriveDoc> {
  return uploadContentAsDoc(accessToken, title, html, 'text/html')
}

async function uploadContentAsDoc(
  accessToken: string,
  title: string,
  content: string,
  contentType: 'text/markdown' | 'text/html',
): Promise<DriveDoc> {
  const boundary = `solus_boundary_${Date.now()}`
  const metadata = JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document' })
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
    docUrl: `https://docs.google.com/document/d/${data.id}/edit`,
  }
}
