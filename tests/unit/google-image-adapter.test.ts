import { beforeEach, expect, mock, test } from 'bun:test'
import { PNG } from 'pngjs'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import type { DocsRequest } from '@solus/server/google/docs-api'
const events: string[] = []
let failShare = false
let sent: DocsRequest[] = []
mock.module('@solus/server/google/oauth', () => ({ getAccessToken: async () => 'test', isGoogleOAuthConfigured: () => true, grantedGoogleScopes: () => [] }))
const drive = await import('@solus/server/google/drive')
mock.module('@solus/server/google/drive', () => ({ ...drive,
  fileMetadata: async () => ({ id: 'doc', name: 'Doc', version: '1' }),
  uploadPng: async () => { events.push('upload'); return 'staged' },
  shareByLink: async () => { events.push('share'); if (failShare) throw new Error('share failed') },
  deleteFile: async () => { events.push('delete staged') },
}))
const api = await import('@solus/server/google/docs-api')
mock.module('@solus/server/google/docs-api', () => ({ ...api,
  getEditableDocument: async () => ({ revisionId: 'r', tabs: [{ tabProperties: { tabId: 'tab' }, documentTab: {
    inlineObjects: { image: { inlineObjectProperties: { embeddedObject: { size: { width: { magnitude: 10, unit: 'PT' }, height: { magnitude: 10, unit: 'PT' } }, imageProperties: { sourceUri: 'original' } } } } },
    body: { content: [
      { startIndex: 1, endIndex: 3, paragraph: { elements: [{ startIndex: 1, endIndex: 2, inlineObjectElement: { inlineObjectId: 'image' } }, { startIndex: 2, endIndex: 3, textRun: { content: '\n' } }] } },
      { startIndex: 3, endIndex: 7, paragraph: { elements: [{ startIndex: 3, endIndex: 7, textRun: { content: 'Map\n' } }] } },
    ] },
  } }] }),
  batchUpdateDocument: async (_token: string, _id: string, requests: DocsRequest[]) => { sent = requests; events.push('batch'); throw new Error('revision rejected') },
}))
mock.module('@solus/server/google/docs-comment-checkpoint', () => ({ commentCheckpoint: async () => ({ quotes: [], save: async () => {} }) }))
const comments = await import('@solus/server/google/comments')
mock.module('@solus/server/google/comments', () => ({ ...comments, listGoogleComments: async () => [] }))
const { GoogleDriveDocAdapter } = await import('@solus/server/docs/gdrive/adapter')
const image = new PNG({ width: 1, height: 1 })
const asset = { workId: 'd', title: 'Map', mimeType: 'image/png' as const, base64: PNG.sync.write(image).toString('base64') }
const ref = { provider: 'gdrive' as const, externalId: 'doc', externalKey: 'root', url: 'https://docs.google.com/document/d/doc/edit' }
const patch = { markdown: serializeDiagramEmbed({ workId: 'd', title: 'Map' }), diagramAssets: [asset] }
beforeEach(() => { events.length = 0; failShare = false; sent = [] })
test('a rejected replacement batch cleans staging and never deletes document content', async () => {
  await expect(new GoogleDriveDocAdapter().update(ref, patch)).rejects.toThrow('revision rejected')
  expect(events).toEqual(['upload', 'share', 'batch', 'delete staged'])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ replaceImage: { imageObjectId: 'image', tabId: 'tab' } })
})
test('a failed share cleans the upload without attempting a document write', async () => {
  failShare = true
  await expect(new GoogleDriveDocAdapter().update(ref, patch)).rejects.toThrow('share failed')
  expect(events).toEqual(['upload', 'share', 'delete staged'])
})
