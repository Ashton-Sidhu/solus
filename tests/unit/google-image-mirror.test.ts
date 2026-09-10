import { expect, mock, test } from 'bun:test'
import type { DocPatch, DocReadHints, GoogleDocImage, NormalizedDoc } from '@solus/contracts/docs'
import { workExternalLinkSchema } from '@solus/server/docs/schema'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
const binding: GoogleDocImage = { workId: 'd1', title: 'Architecture', objectId: 'image', tabId: 'tab', sourceUri: 'original', contentHash: 'hash' }
const markdown = serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' })
const upstream: NormalizedDoc = { ref: { provider: 'gdrive', externalId: 'image-mirror', externalKey: 'root', url: 'https://docs.google.com/document/d/image-mirror/edit' }, title: 'Doc', markdown, version: '1', googleImages: [binding] }
let patch: DocPatch | undefined, hints: DocReadHints | undefined
mock.module('@solus/server/docs/registry', () => ({ docProviderAdapter: () => ({
  create: async () => upstream,
  read: async (_ref: typeof upstream.ref, value?: DocReadHints) => { hints = value; return upstream },
  update: async (_ref: typeof upstream.ref, value: DocPatch) => { patch = value; return upstream },
}) }))
const { publishMirror, refreshMirror, pullMirror } = await import('@solus/server/docs/mirror')

test('image identity survives publish without fresh renders and explicit pull accepts external pixels', async () => {
  const created = await publishMirror({ title: 'Doc', content: markdown, destination: { provider: 'gdrive', scope: 'root', label: 'Drive' }, diagramAssets: [{ workId: 'd1', title: 'Architecture', mimeType: 'image/png', base64: 'fixture' }] })
  if (!created.ok) throw new Error('Create failed')
  expect(created.link.googleImages).toEqual([binding])
  expect(workExternalLinkSchema.parse(created.link).googleImages).toEqual([binding])
  const updated = await publishMirror({ title: 'Doc', content: markdown, link: created.link })
  expect(updated.ok).toBe(true)
  expect(patch?.markdown).toBe(markdown)
  expect(patch?.googleImages).toEqual([binding])
  upstream.version = '2'
  upstream.googleImages = [{ ...binding, sourceUri: 'externally-replaced', contentHash: '' }]
  const changed = await refreshMirror(created.link)
  expect(changed.syncState).toBe('upstream_changed')
  expect(changed.upstreamVersion).toBe('1')
  expect(hints?.googleImages).toEqual([binding])
  const pulled = await pullMirror(created.link)
  expect(pulled.link.googleImages?.[0].sourceUri).toBe('externally-replaced')
})
