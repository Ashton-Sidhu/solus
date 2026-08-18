import { afterEach, describe, expect, mock, test } from 'bun:test'
import { uploadHtmlAsDoc } from '../../src/main/google/drive'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Google Drive document upload', () => {
  test('imports diagram documents as HTML', async () => {
    let requestBody = ''
    globalThis.fetch = mock(async (_input, init) => {
      // SAFETY: uploadHtmlAsDoc always sends its multipart body as a Node Buffer.
      requestBody = Buffer.from(init?.body as Buffer).toString('utf8')
      return new Response(JSON.stringify({ id: 'doc-1' }), { status: 200 })
    })

    const result = await uploadHtmlAsDoc('token', 'Architecture', '<p>Body</p>')

    expect(requestBody).toContain('Content-Type: text/html; charset=UTF-8')
    expect(requestBody).toContain('<p>Body</p>')
    expect(result.docUrl).toBe('https://docs.google.com/document/d/doc-1/edit')
  })
})
