import { getContext, setContext } from 'svelte'
import type { TaskLinkContext } from '../../tasks/link-control/lib/task-link-control'

/**
 * The conversation an HTML block was read in. A block is rendered from deep
 * inside the markdown tree, where the transcript's own props do not reach, but
 * saving one as an artifact has to file the work against the right session's
 * host, project, and working directory — not merely the active tab, which is
 * the wrong answer whenever a second conversation is open in a split.
 */
export interface HtmlBlockOrigin {
  tabId: string
  linkContext: TaskLinkContext
  /** How far, in px, a widened render may grow past each side of the reading
   *  column. Zero offers no Widen. */
  sideRoom: number
}

/** The clear space a widened render keeps at each pane edge. The left one
 *  holds the message navigator (3rem from the edge) and, right of it, the
 *  reply's time and copy rail (`MessageHoverRail`), which moves out beside the
 *  render. */
export const WIDE_RENDER_EDGE_PX = 104
/** Less room than this is not worth a control. */
const MIN_WIDE_ROOM_PX = 32

/** `transcriptWidth` is the scroller's client width, padding included;
 *  `readingColumnWidth` is the centered column inside it. */
export function wideRenderRoom(transcriptWidth: number, readingColumnWidth: number): number {
  const room = Math.floor((transcriptWidth - readingColumnWidth) / 2 - WIDE_RENDER_EDGE_PX)
  return room >= MIN_WIDE_ROOM_PX ? room : 0
}

const HTML_BLOCK_ORIGIN = Symbol('html-block-origin')

export function setHtmlBlockOrigin(origin: () => HtmlBlockOrigin): void {
  setContext(HTML_BLOCK_ORIGIN, origin)
}

export function getHtmlBlockOrigin(): (() => HtmlBlockOrigin) | undefined {
  return getContext<(() => HtmlBlockOrigin) | undefined>(HTML_BLOCK_ORIGIN)
}
