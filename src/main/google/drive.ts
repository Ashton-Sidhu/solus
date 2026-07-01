import { net } from 'electron'

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'

export interface DriveDoc {
  docId: string
  docUrl: string
}

function netRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url })
    for (const [key, value] of Object.entries(headers)) {
      req.setHeader(key, value)
    }
    req.on('response', (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk.toString() })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
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

  const res = await netRequest('POST', UPLOAD_URL, {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': `multipart/related; boundary=${boundary}`,
  }, body)

  if (res.status !== 200) throw new Error(`Drive upload failed (${res.status}): ${res.body}`)

  const data = JSON.parse(res.body) as { id: string }
  return {
    docId: data.id,
    docUrl: `https://docs.google.com/document/d/${data.id}/edit`,
  }
}
