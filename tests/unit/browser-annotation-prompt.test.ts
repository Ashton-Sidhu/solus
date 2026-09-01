import { describe, expect, test } from 'bun:test'
import {
  annotationLine,
  composeAnnotationPrompt,
} from '@solus/workspace-ui/components/browser/lib/annotation-prompt'
import {
  annotationAttachmentId,
  commentedAnnotationState,
  createAnnotationAttachment,
  mergeAnnotationAttachment,
} from '@solus/workspace-ui/components/browser/lib/annotation-attachment'
import { defaultViewport, type BrowserAnnotation, type BrowserPage } from '@solus/contracts/browser-types'

/**
 * What the user's marks become.
 *
 * The point of annotating at all is that the agent is told which file to open
 * rather than being handed a picture and asked to guess. These tests pin the
 * facts that carry that: the source location and the user's own words.
 */

function page(): BrowserPage {
  return {
    browserPageId: 'browser_1',
    target: { kind: 'url', url: 'http://localhost:5173/' },
    url: 'http://localhost:5173/',
    title: 'App',
    viewport: defaultViewport(),
    appearance: 'system',
    hostKind: 'webview',
    loadState: 'ready',
    canGoBack: false,
    canGoForward: false,
    devToolsOpen: false,
    annotationTool: 'pick',
    label: 'localhost:5173',
    createdAt: 1,
  }
}

const PICKED: BrowserAnnotation = {
  id: 'an1',
  tool: 'pick',
  rect: { x: 10, y: 20, width: 100, height: 32 },
  element: {
    role: 'button',
    label: 'Save',
    rect: { x: 10, y: 20, width: 100, height: 32 },
    ref: '[data-solus-browser-ref="a1"]',
    source: { file: 'src/components/Save.svelte', line: 42, column: 4 },
  },
  createdAt: 1,
}

describe('annotation prompt', () => {
  test('a picked element names its source file and line', () => {
    // WHY: this is the entire reason `pick` exists. Without file:line the mark
    // is a screenshot region and the agent still has to go looking.
    expect(annotationLine(PICKED, 0)).toContain('src/components/Save.svelte:42')
    expect(annotationLine(PICKED, 0)).toContain('"Save"')
  })

  test('the mark is numbered as the overlay drew it', () => {
    // WHY: the picture the agent reads has numbers painted on it. If the list
    // numbered differently the two would refer to different marks.
    expect(annotationLine(PICKED, 2).startsWith('3.')).toBe(true)
  })

  test("a mark's stable number wins over its position in the list", () => {
    // WHY: the overlay numbers in click order and keeps the number through reorder,
    // so after an earlier mark is removed the line must still read the painted
    // number — here 4 — not where the mark now sits in the list.
    const stable = { ...PICKED, number: 4 }
    expect(annotationLine(stable, 0).startsWith('4.')).toBe(true)
  })

  test("the user's own words come last, where a reader stops", () => {
    const noted = { ...PICKED, note: 'padding is too tight' }
    expect(annotationLine(noted, 0).endsWith('— padding is too tight')).toBe(true)
  })

  test('a drawn mark describes the rectangle, since it names no element', () => {
    const drawn: BrowserAnnotation = {
      id: 'an2',
      tool: 'draw',
      rect: { x: 4, y: 8, width: 200, height: 60 },
      path: [{ x: 4, y: 8 }, { x: 204, y: 68 }],
      createdAt: 2,
    }
    expect(annotationLine(drawn, 0)).toContain('200×60 at 4,8')
  })

  test('a box names every element it selected', () => {
    // WHY: the box is now a DOM marquee, not an anonymous screenshot region.
    // The agent needs every selected selector and source location to act on the
    // group the user drew around.
    const selected: BrowserAnnotation = {
      id: 'an3',
      tool: 'region',
      rect: { x: 10, y: 20, width: 220, height: 60 },
      elements: [
        PICKED.element!,
        {
          role: 'input',
          label: 'Title',
          identifier: 'title',
          rect: { x: 120, y: 20, width: 110, height: 32 },
          ref: '[data-solus-browser-ref="a2"]',
          source: { file: 'src/components/Title.svelte', line: 9, column: 2 },
        },
      ],
      createdAt: 3,
    }
    const line = annotationLine(selected, 0)
    expect(line).toContain('box selected 2 elements')
    expect(line).toContain('src/components/Save.svelte:42')
    expect(line).toContain('src/components/Title.svelte:9')
  })

  test('the capture is embedded so the numbered list has a picture to refer to', () => {
    const prompt = composeAnnotationPrompt({
      page: page(),
      state: { browserPageId: 'browser_1', annotations: [PICKED] },
      assetId: 'abc123',
    })
    expect(prompt).toContain('![annotated browser](asset://abc123)')
  })

  test('a capture that failed does not silence the marks', () => {
    // WHY: the words and the source locations are the part that says what to
    // change. Losing them because a screenshot timed out would be the wrong
    // trade.
    const prompt = composeAnnotationPrompt({
      page: page(),
      state: { browserPageId: 'browser_1', annotations: [PICKED] },
    })
    expect(prompt).toContain('src/components/Save.svelte:42')
    expect(prompt).not.toContain('asset://')
  })

  test('nothing marked produces no message at all', () => {
    // WHY: a prompt that says "I marked up the page" with no marks is a wasted
    // turn, and the button that produced it looked like it worked.
    expect(composeAnnotationPrompt({
      page: page(),
      state: { browserPageId: 'browser_1', annotations: [] },
    })).toBeNull()
  })

  test('one submitted annotation becomes one stable composer attachment', () => {
    const commented = { ...PICKED, note: 'Make the button easier to see' }
    const attachment = createAnnotationAttachment({
      page: page(),
      state: { browserPageId: 'browser_1', annotations: [commented] },
      serverId: 'host-1',
      evidence: {
        browserPageId: 'browser_1',
        assetId: 'abc123.png',
        hostPath: '/srv/solus/assets/abc123.png',
        attachedTo: 'the asset store',
        url: 'http://localhost:5173/',
        viewport: 'Fill pane — 1280×800',
        capturedAt: 2,
      },
    })

    expect(attachment?.id).toBe(annotationAttachmentId('host-1', 'browser_1'))
    expect(attachment?.type).toBe('design-selection')
    expect(attachment?.hostPath).toBe('/srv/solus/assets/abc123.png')
    expect(attachment?.designData?.annotationContext).toContain('src/components/Save.svelte:42')
    expect(attachment?.designData?.annotations).toBeUndefined()
    expect(attachment?.designData?.browserMarks?.[0]?.id).toBe('an1')
  })

  test('capture failure keeps the structured attachment sendable', () => {
    const commented = { ...PICKED, note: 'Make the button easier to see' }
    const attachment = createAnnotationAttachment({
      page: page(),
      state: { browserPageId: 'browser_1', annotations: [commented] },
      serverId: 'host-1',
    })
    expect(attachment?.hostPath).toBeUndefined()
    expect(attachment?.designData?.annotationContext).toContain('src/components/Save.svelte:42')
  })

  test('a later transient mark merges into the stable page attachment', () => {
    // WHY: a commented mark is removed from the page immediately. The next
    // guest read therefore contains only the new mark, but the draft must keep
    // both comments and both normalized rectangles for the agent.
    const first = createAnnotationAttachment({
      page: page(),
      state: {
        browserPageId: 'browser_1',
        annotations: [{ ...PICKED, note: 'Increase contrast' }],
      },
      serverId: 'host-1',
    })!
    const second = createAnnotationAttachment({
      page: page(),
      state: {
        browserPageId: 'browser_1',
        annotations: [{
          ...PICKED,
          id: 'an2',
          number: 2,
          note: 'Add more space',
        }],
      },
      serverId: 'host-1',
    })!

    const merged = mergeAnnotationAttachment(first, second)
    expect(merged.designData?.browserMarks?.map((mark) => mark.id)).toEqual(['an1', 'an2'])
    expect(merged.designData?.annotations).toBeUndefined()
    expect(merged.designData?.annotationContext).toContain('1. <button>')
    expect(merged.designData?.annotationContext).toContain('2. <button>')
    expect(merged.designData?.annotationContext).toContain('Increase contrast')
    expect(merged.designData?.annotationContext).toContain('Add more space')
  })

  test('only commented marks persist in the composer attachment', () => {
    // WHY: a gesture is temporary page markup until the user says what the
    // agent should change. One uncommented gesture must not ride along with a
    // different mark that does have a comment.
    const commented = {
      ...PICKED,
      id: 'an2',
      note: 'Make the button easier to see',
    }
    const state = commentedAnnotationState({
      browserPageId: 'browser_1',
      annotations: [PICKED, commented],
    })
    expect(state?.annotations.map((annotation) => annotation.id)).toEqual(['an2'])

    const attachment = createAnnotationAttachment({
      page: page(),
      state: {
        browserPageId: 'browser_1',
        annotations: [PICKED, commented],
      },
      serverId: 'host-1',
    })
    expect(attachment?.designData?.browserMarks?.map((mark) => mark.id)).toEqual(['an2'])
  })

  test('a mark without a comment creates no composer attachment', () => {
    // WHY: leaving the note empty must have the same durable result as Skip.
    expect(createAnnotationAttachment({
      page: page(),
      state: { browserPageId: 'browser_1', annotations: [PICKED] },
      serverId: 'host-1',
    })).toBeNull()
  })
})
