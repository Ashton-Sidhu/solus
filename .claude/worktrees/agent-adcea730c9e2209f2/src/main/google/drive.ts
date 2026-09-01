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
  const boundary = `solus_boundary_${Date.now()}`
  const metadata = JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document' })
  const markdownBytes = Buffer.from(markdown, 'utf-8')
  const metadataBytes = Buffer.from(metadata, 'utf-8')

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    metadataBytes,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n`),
    markdownBytes,
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

  const data = JSON.parse(responseBody) as { id: string }
  return {
    docId: data.id,
    docUrl: `https://docs.google.com/document/d/${data.id}/edit`,
  }
}
