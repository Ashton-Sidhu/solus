import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import { parseDiagramEmbed, findDiagramEmbeds, type DiagramEmbedReference } from '@solus/contracts/diagram-embed'
import type { DocDiagramAsset, GoogleDocImage } from '@solus/contracts/docs'
import { pngPixelSize } from '../docs/png'
import { type EditableDocument, UNSUPPORTED_GOOGLE_EDIT } from './docs-edit-schema'
import { compileDocsBlocks } from './docs-requests'
import { paragraphText } from './docs-edit-plan'

interface ExistingImage { objectId: string; caption: string; width: number; height: number; sourceUri: string; captionIndex: number }
export interface ImageReplacement { asset: DocDiagramAsset; binding: GoogleDocImage; width: number; height: number }
export interface GoogleImagePlan { markdown: string; bindings: GoogleDocImage[]; replacements: ImageReplacement[] }
const MAX_PIXELS = 25_000_000

/** Validate identity before creation allocates a remote document. */
export function validateGoogleImageDraft(markdown: string, assets: DocDiagramAsset[]): void {
  if (!assets.length) return
  const references = findDiagramEmbeds(markdown)
  const ids = references.map(reference => reference.workId)
  if (new Set(ids).size !== ids.length || new Set(assets.map(asset => asset.workId)).size !== assets.length || new Set(assets.map(asset => asset.title)).size !== assets.length) throw new Error('Each diagram needs a unique image identity and caption.')
  if (assets.some(asset => !ids.includes(asset.workId) || !asset.title.trim() || /[\r\n]/.test(asset.title)) || references.some(reference => !assets.some(asset => asset.workId === reference.workId))) throw new Error('Each diagram embed needs a rendered image and a single-line caption.')
}

function imageHash(asset: Pick<DocDiagramAsset, 'base64'>): string {
  return createHash('sha256').update(Buffer.from(asset.base64, 'base64')).digest('hex')
}

interface ImageCaption { text: string; index: number }
function imageCaption(document: EditableDocument, index: number): ImageCaption {
  const content = document.tabs[0].documentTab.body.content
  for (let position = index + 1; position < content.length; position++) {
    const next = content[position]
    if (!('paragraph' in next) || next.paragraph.elements.some(run => 'inlineObjectElement' in run)) break
    const caption = paragraphText(next)
    if (caption.trim()) return { text: caption, index: position }
  }
  return { text: '', index: -1 }
}

function existingImages(document: EditableDocument): ExistingImage[] {
  const tab = document.tabs[0].documentTab, content = tab.body.content
  const images: ExistingImage[] = []
  for (let index = 0; index < content.length; index++) {
    const element = content[index]
    if (!('paragraph' in element)) continue
    const objects = element.paragraph.elements.flatMap(run => 'inlineObjectElement' in run ? [run.inlineObjectElement.inlineObjectId] : [])
    if (!objects.length) continue
    if (objects.length !== 1 || element.paragraph.elements.some(run => 'textRun' in run && run.textRun.content.trim())) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    const caption = imageCaption(document, index)
    const embedded = tab.inlineObjects?.[objects[0]]?.inlineObjectProperties.embeddedObject
    const width = embedded?.size.width, height = embedded?.size.height
    if (!embedded?.imageProperties || width?.unit !== 'PT' || height?.unit !== 'PT' || !width.magnitude || !height.magnitude) continue
    images.push({ objectId: objects[0], caption: caption.text, captionIndex: caption.index, width: width.magnitude, height: height.magnitude, sourceUri: embedded.imageProperties.sourceUri ?? '' })
  }
  return images
}

/** Bootstrap old links only when the original caption selects exactly one
 * image. After that, object IDs are authoritative and captions may be renamed. */
export function bindGoogleImages(document: EditableDocument, assets: (DiagramEmbedReference & { base64?: string })[]): GoogleDocImage[] {
  const images = existingImages(document), tabId = document.tabs[0].tabProperties.tabId
  return assets.map(asset => {
    const matches = images.filter(image => image.caption === asset.title)
    if (matches.length !== 1) throw new Error(`Cannot identify the Google image for “${asset.title}” safely.`)
    const image = matches[0]
    return { workId: asset.workId, title: asset.title, objectId: image.objectId, tabId, sourceUri: image.sourceUri, contentHash: asset.base64 ? imageHash({ base64: asset.base64 }) : '' }
  })
}

function escapeCaption(title: string): string {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  return title.replace(/[\\`*_{}[\]()#+.!|<>-]/g, '\\$&')
}

export function planGoogleImages(document: EditableDocument, markdown: string, assets: DocDiagramAsset[], saved: GoogleDocImage[] = []): GoogleImagePlan {
  const references = findDiagramEmbeds(markdown)
  const ids = references.map(reference => reference.workId)
  if (new Set(ids).size !== ids.length || new Set(assets.map(asset => asset.workId)).size !== assets.length) throw new Error('Each published diagram must identify one image.')
  if (assets.some(asset => !ids.includes(asset.workId))) throw new Error('A supplied diagram image is not present in the document.')
  if (saved.some(binding => !ids.includes(binding.workId))) throw new Error('Removing existing diagram images is not supported yet.')
  if (!references.length && !assets.length && !saved.length) return { markdown, bindings: [], replacements: [] }
  const existing = existingImages(document)
  const bindings: GoogleDocImage[] = [], replacements: ImageReplacement[] = []
  for (const reference of references) {
    const asset = assets.find(candidate => candidate.workId === reference.workId)
    const previous = saved.find(binding => binding.workId === reference.workId)
    const binding = previous ? { ...previous } : bindGoogleImages(document, [asset ?? reference])[0]
    if (!binding) throw new Error('This diagram has no saved Google image mapping. Publish its rendered image from Solus first.')
    const image = existing.find(candidate => candidate.objectId === binding.objectId)
    if (!image || binding.tabId !== document.tabs[0].tabProperties.tabId || image.caption !== binding.title || image.sourceUri !== binding.sourceUri) throw new Error('The Google image changed upstream. Pull and review it before replacing it.')
    if (asset) {
      binding.title = asset.title
      // A legacy binding has no trustworthy last-published pixel hash.
      if (!previous || binding.contentHash !== imageHash(asset)) {
        binding.contentHash = imageHash(asset)
        replacements.push({ asset, binding, width: image.width, height: image.height })
      }
    }
    bindings.push(binding)
  }
  const text = markdown.split(/\r?\n/).map(line => {
    const reference = parseDiagramEmbed(line)
    if (!reference) return line
    const binding = bindings.find(candidate => candidate.workId === reference.workId)
    if (!binding) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    return escapeCaption(binding.title)
  }).join('\n')
  validateImagePositions(document, text, existing, bindings)
  return { markdown: text, bindings, replacements }
}

function validateImagePositions(document: EditableDocument, markdown: string, images: ExistingImage[], bindings: GoogleDocImage[]): void {
  const content = document.tabs[0].documentTab.body.content
  const visible = content.filter(element => 'table' in element || ('paragraph' in element && !element.paragraph.elements.some(run => 'inlineObjectElement' in run) && paragraphText(element).trim()))
  const blocks = compileDocsBlocks(markdown, []).filter(block => block.kind !== 'paragraph' || block.text.text.trim())
  let lastIndex = -1
  for (const binding of bindings) {
    const image = images.find(candidate => candidate.objectId === binding.objectId)!
    const index = visible.indexOf(content[image.captionIndex])
    const block = blocks[index]
    if (index <= lastIndex || block?.kind !== 'paragraph' || block.text.text !== binding.title) throw new Error('Moving existing diagram images is not supported yet. Keep each image in its current document position.')
    lastIndex = index
  }
}

/** Google only offers CENTER_CROP at the existing display size. Transparent
 * padding gives it the same aspect ratio without cutting diagram content. */
export function replacementPng(asset: DocDiagramAsset, boxWidth: number, boxHeight: number): Buffer {
  const bytes = Buffer.from(asset.base64, 'base64'), size = pngPixelSize(bytes)
  if (!size || size.width * size.height > MAX_PIXELS || !Number.isFinite(boxWidth / boxHeight) || boxWidth <= 0 || boxHeight <= 0) throw new Error('The replacement image dimensions are not supported.')
  const image = PNG.sync.read(bytes, { checkCRC: true })
  const ratio = boxWidth / boxHeight
  const width = Math.max(image.width + 2, Math.ceil((image.height + 2) * ratio))
  const height = Math.max(image.height + 2, Math.ceil((image.width + 2) / ratio))
  if (width * height > MAX_PIXELS) throw new Error('The replacement image is too large for the existing image box.')
  const padded = new PNG({ width, height, fill: true })
  const x = Math.floor((width - image.width) / 2), y = Math.floor((height - image.height) / 2)
  PNG.bitblt(image, padded, 0, 0, image.width, image.height, x, y)
  return PNG.sync.write(padded)
}

/** An explicit pull accepts the current image version. Clear the pixel hash
 * when Google changed its source so a later render cannot be mistaken for a no-op. */
export function refreshGoogleImages(document: EditableDocument, saved: GoogleDocImage[]): GoogleDocImage[] {
  const images = existingImages(document), tabId = document.tabs[0].tabProperties.tabId
  return saved.flatMap(binding => {
    const image = images.find(candidate => candidate.objectId === binding.objectId)
    if (!image || binding.tabId !== tabId) return []
    return [{ ...binding, title: image.caption, sourceUri: image.sourceUri, contentHash: image.sourceUri === binding.sourceUri ? binding.contentHash : '' }]
  })
}
