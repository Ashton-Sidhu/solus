import { expect, test } from 'bun:test'
import { PNG } from 'pngjs'
import { bindGoogleImages, planGoogleImages, replacementPng, refreshGoogleImages, validateGoogleImageDraft } from '@solus/server/google/docs-images'
import { editableDocumentSchema, planGoogleDocEdit } from '@solus/server/google/docs-edit-plan'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import type { DocDiagramAsset } from '@solus/contracts/docs'

function asset(color = 100, title = 'Architecture'): DocDiagramAsset {
  const png = new PNG({ width: 4, height: 2 })
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = color; png.data[i + 3] = 255 }
  return { workId: 'diagram', title, mimeType: 'image/png', base64: PNG.sync.write(png).toString('base64') }
}
function fixture() {
  return editableDocumentSchema.parse({ revisionId: 'r', tabs: [{ tabProperties: { tabId: 'tab' }, documentTab: {
    inlineObjects: { image: { inlineObjectProperties: { embeddedObject: { size: { width: { magnitude: 200, unit: 'PT' }, height: { magnitude: 100, unit: 'PT' } }, imageProperties: { sourceUri: 'https://example.com/original.png' } } } } },
    body: { content: [
      { startIndex: 1, endIndex: 3, paragraph: { elements: [{ startIndex: 1, endIndex: 2, inlineObjectElement: { inlineObjectId: 'image' } }, { startIndex: 2, endIndex: 3, textRun: { content: '\n' } }] } },
      { startIndex: 3, endIndex: 16, paragraph: { elements: [{ startIndex: 3, endIndex: 16, textRun: { content: 'Architecture\n' } }] } },
    ] },
  } }] })
}
const markdown = serializeDiagramEmbed({ workId: 'diagram', title: 'Architecture' })
test('saved object identity supports pixel replacement and caption rename without body deletion', () => {
  const document = fixture(), saved = bindGoogleImages(document, [asset()])
  const plan = planGoogleImages(document, markdown, [asset(200, 'New architecture')], saved)
  expect(plan.replacements).toHaveLength(1)
  expect(plan.replacements[0].binding.objectId).toBe('image')
  expect(plan.bindings[0].title).toBe('New architecture')
  expect(saved[0].title).toBe('Architecture')
  expect(plan.markdown).toBe('New architecture')
})
test('unchanged pixels and publications without new renders preserve the existing image', () => {
  const document = fixture(), saved = bindGoogleImages(document, [asset()])
  for (const assets of [[asset()], []]) {
    const plan = planGoogleImages(document, markdown, assets, saved)
    expect(plan.replacements).toEqual([])
    expect(planGoogleDocEdit(document, plan.markdown, [])).toEqual([])
  }
})
test('missing, duplicate, removed and upstream-changed images fail before staging', () => {
  const document = fixture(), saved = bindGoogleImages(document, [asset()])
  expect(() => planGoogleImages(document, markdown + '\n\n' + markdown, [asset()], saved)).toThrow('one image')
  expect(() => planGoogleImages(document, 'No diagram.', [], saved)).toThrow('Removing')
  const changed = [{ ...saved[0], sourceUri: 'different' }]
  expect(() => planGoogleImages(document, markdown, [asset(200)], changed)).toThrow('upstream')
  expect(() => planGoogleImages(document, markdown, [asset()], [{ ...saved[0], objectId: 'missing' }])).toThrow('upstream')
})
test('legacy caption matching is unique and explicit pull accepts an external image version', () => {
  const document = fixture(), saved = bindGoogleImages(document, [asset()])
  expect(planGoogleImages(document, markdown, [], []).bindings[0].contentHash).toBe('')
  expect(planGoogleImages(document, markdown, [asset()], []).replacements).toHaveLength(1)
  document.tabs[0].documentTab.inlineObjects!.image.inlineObjectProperties.embeddedObject.imageProperties!.sourceUri = 'https://example.com/new.png'
  const refreshed = refreshGoogleImages(document, saved)
  expect(refreshed[0].contentHash).toBe('')
  expect(() => planGoogleImages(document, markdown, [asset(200)], refreshed)).not.toThrow()
})
test('padding preserves every opaque source pixel and fits the existing image box', () => {
  const bytes = replacementPng(asset(), 100, 100)
  const decoded = PNG.sync.read(bytes)
  expect(decoded.width).toBe(decoded.height)
  let pixels = 0
  for (let i = 0; i < decoded.data.length; i += 4) if (decoded.data[i + 3]) { pixels++; expect(decoded.data[i]).toBe(100) }
  expect(pixels).toBe(8)
  expect(decoded.data[3]).toBe(0)
  expect(() => replacementPng(asset(), 1e9, 1)).toThrow('too large')
})

test('moving a diagram cannot silently relabel an image left at its original position', () => {
  const document = fixture(), saved = bindGoogleImages(document, [asset()])
  expect(() => planGoogleImages(document, 'New preceding paragraph.\n\n' + markdown, [asset()], saved)).toThrow('Moving existing')
})

test('new image documents reject ambiguous identities before allocating a remote document', () => {
  expect(() => validateGoogleImageDraft(markdown + '\n\n' + markdown, [asset()])).toThrow('unique')
  expect(() => validateGoogleImageDraft('No diagram.', [asset()])).toThrow('Each diagram')
})
