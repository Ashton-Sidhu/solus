import { getContext, setContext } from 'svelte'

const UNDER_STRIP = Symbol('under-companion-strip')

/**
 * Tell the surfaces below whether they sit under the companion pane's strip.
 * The strip is that pane's header: it draws the seam, maximize, and the way
 * out, so a surface under it drops its own border and floating cluster.
 */
export function setUnderStrip(read: () => boolean): void {
  setContext(UNDER_STRIP, read)
}

/** Read with a call, so the answer follows the pane the surface is in. A
 *  surface mounted outside a pane outlet has no strip above it. */
export function underStrip(): () => boolean {
  return getContext<(() => boolean) | undefined>(UNDER_STRIP) ?? (() => false)
}
