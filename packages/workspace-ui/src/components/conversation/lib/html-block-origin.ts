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
}

const HTML_BLOCK_ORIGIN = Symbol('html-block-origin')

export function setHtmlBlockOrigin(origin: () => HtmlBlockOrigin): void {
  setContext(HTML_BLOCK_ORIGIN, origin)
}

export function getHtmlBlockOrigin(): (() => HtmlBlockOrigin) | undefined {
  return getContext<(() => HtmlBlockOrigin) | undefined>(HTML_BLOCK_ORIGIN)
}
