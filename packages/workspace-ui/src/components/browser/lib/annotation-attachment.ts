import type { Attachment, BrowserMark } from '@solus/contracts/types'
import type {
  BrowserAnnotation,
  BrowserAnnotationState,
  BrowserElement,
  BrowserEvidence,
  BrowserPage,
} from '@solus/contracts/browser-types'
import { composeAnnotationPrompt } from './annotation-prompt'

export interface AnnotationAttachmentInput {
  page: BrowserPage
  state: BrowserAnnotationState
  serverId: string
  evidence?: BrowserEvidence | null
}

/** Only marks with the user's words belong in the draft composer. A gesture is
 * temporary page markup until the user explains what the agent should change. */
export function commentedAnnotationState(
  state: BrowserAnnotationState,
): BrowserAnnotationState | null {
  const annotations = state.annotations.filter((annotation) => annotation.note?.trim())
  if (!annotations.length) return null
  return { ...state, annotations }
}

/** One annotation session becomes one stable composer attachment. Re-attaching
 * the same browser page replaces its earlier draft card instead of adding a
 * second copy. */
export function annotationAttachmentId(serverId: string, browserPageId: string): string {
  return `browser-annotation:${serverId}:${browserPageId}`
}

/** Which page a draft annotation came from, so removing a chip can also clear
 *  its mark from the page it was made on. Null for any other attachment. */
export function parseAnnotationAttachmentId(
  id: string,
): { serverId: string; browserPageId: string } | null {
  const parts = id.split(':')
  if (parts.length !== 3 || parts[0] !== 'browser-annotation') return null
  return { serverId: parts[1], browserPageId: parts[2] }
}

/** The mark's stable ordinal, with the same fallback the prompt uses, so a chip
 *  and its line in the prompt cannot name the mark differently. */
export function markPin(annotation: BrowserAnnotation, index: number): number {
  return annotation.number ?? index + 1
}

/**
 * How the element reads, in the same words the overlay writes on the page.
 *
 * `ref` is never it. The guest mints a ref as `[data-solus-browser-ref="a1"]` —
 * a handle for the drive verbs, not a name: it identifies nothing to a reader
 * and fills a chip end to end with an id that means nothing outside that page
 * load. The overlay's own pick tag already states the readable form, so this
 * mirrors it exactly; a chip and the tag on the element it points at must not
 * name the same thing differently.
 */
function markSelector(element: BrowserElement | undefined): string | undefined {
  if (!element) return undefined
  const role = element.role || 'element'
  if (element.identifier) return `${role}#${element.identifier}`
  if (element.label) return `${role} · ${element.label}`
  return role
}

function browserMark(annotation: BrowserAnnotation, index: number): BrowserMark {
  const element = annotation.element ?? annotation.elements?.[0]
  return {
    id: annotation.id,
    tool: annotation.tool,
    pin: markPin(annotation, index),
    selector: markSelector(element),
    note: annotation.note,
  }
}

function attachmentName(state: BrowserAnnotationState): string {
  const count = state.annotations.length
  const firstWords = state.annotations.find((annotation) => annotation.note?.trim())?.note?.trim()
  if (firstWords) return firstWords
  return count === 1 ? 'Browser annotation' : `${count} browser annotations`
}

/** Build the draft attachment before the guest marks are cleared. The screenshot
 * is best-effort: structured element and source context still attaches when
 * capture fails. */
export function createAnnotationAttachment(input: AnnotationAttachmentInput): Attachment | null {
  const state = commentedAnnotationState(input.state)
  if (!state) return null
  const context = composeAnnotationPrompt({ page: input.page, state })
  if (!context) return null
  const firstElement = state.annotations
    .map((annotation) => annotation.element ?? annotation.elements?.[0])
    .find((element) => element !== undefined)
  return {
    id: annotationAttachmentId(input.serverId, input.page.browserPageId),
    type: 'design-selection',
    name: attachmentName(state),
    path: input.evidence?.hostPath ?? input.page.url,
    hostPath: input.evidence?.hostPath,
    hostServerId: input.evidence ? input.serverId : undefined,
    mimeType: input.evidence ? 'image/png' : undefined,
    designData: {
      screenshot: input.evidence ? `asset://${input.evidence.assetId}` : '',
      cssSelector: firstElement?.ref,
      componentName: firstElement?.label || firstElement?.role,
      componentFile: firstElement?.source?.file,
      pageURL: input.page.url,
      viewport: { width: input.page.viewport.width, height: input.page.viewport.height },
      browserMarks: state.annotations.map(browserMark),
      browserAppearance: input.page.appearance === 'system' ? undefined : input.page.appearance,
      annotationContext: context,
    },
  }
}

function mergedById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) merged.set(item.id, item)
  return [...merged.values()]
}

function markLines(context: string | undefined): string[] {
  return context?.split('\n').filter((line) => /^\d+\. /.test(line)) ?? []
}

/**
 * Add a newly-commented mark to the stable attachment for this browser page.
 *
 * The guest removes each visual mark after its comment reaches the composer.
 * A later comment therefore arrives as a one-mark attachment and must merge
 * with the draft instead of replacing the earlier context that is no longer
 * present in the page.
 */
export function mergeAnnotationAttachment(
  current: Attachment,
  incoming: Attachment,
): Attachment {
  const currentData = current.designData
  const incomingData = incoming.designData
  if (!currentData || !incomingData) return incoming

  const lines = mergedById(
    markLines(currentData.annotationContext).map((line) => ({ id: line.split('.')[0]!, line })),
    markLines(incomingData.annotationContext).map((line) => ({ id: line.split('.')[0]!, line })),
  ).map(({ line }) => line)
  const heading = 'Marks, numbered as they appear in the image:'
  const incomingContext = incomingData.annotationContext ?? currentData.annotationContext
  const contextPrefix = incomingContext?.split(`\n${heading}`)[0]
  const annotationContext = contextPrefix && lines.length
    ? [
        contextPrefix,
        '',
        heading,
        ...lines,
      ].join('\n')
    : incomingContext

  return {
    ...incoming,
    name: current.name,
    hostPath: incoming.hostPath ?? current.hostPath,
    hostServerId: incoming.hostServerId ?? current.hostServerId,
    mimeType: incoming.mimeType ?? current.mimeType,
    dataUrl: incoming.dataUrl ?? current.dataUrl,
    designData: {
      ...currentData,
      ...incomingData,
      screenshot: incomingData.screenshot || currentData.screenshot,
      cssSelector: currentData.cssSelector ?? incomingData.cssSelector,
      componentName: currentData.componentName ?? incomingData.componentName,
      componentFile: currentData.componentFile ?? incomingData.componentFile,
      browserMarks: mergedById(currentData.browserMarks ?? [], incomingData.browserMarks ?? []),
      annotationContext,
    },
  }
}

/** The prompt writes one line per mark, opening with the pin. Removing a chip
 *  takes that line with it, so the words sent never describe a mark the reader
 *  cannot see. */
function withoutMarkLine(context: string | undefined, pin: number): string | undefined {
  if (!context) return context
  const prefix = `${pin}. `
  return context
    .split('\n')
    .filter((line) => !line.startsWith(prefix))
    .join('\n')
}

/**
 * Drop one mark from a draft attachment.
 *
 * Returns null when it was the last mark: an annotation with nothing marked is
 * an empty chip, and the composer should lose it rather than hold a frame the
 * user has no words about. The remaining pins keep their numbers.
 */
export function removeMarkFromAttachment(
  attachment: Attachment,
  markId: string,
): Attachment | null {
  const data = attachment.designData
  if (!data) return attachment
  const marks = (data.browserMarks ?? []).filter((mark) => mark.id !== markId)
  if (!marks.length) return null
  const removed = (data.browserMarks ?? []).find((mark) => mark.id === markId)
  return {
    ...attachment,
    designData: {
      ...data,
      browserMarks: marks,
      annotationContext: removed
        ? withoutMarkLine(data.annotationContext, removed.pin)
        : data.annotationContext,
    },
  }
}
