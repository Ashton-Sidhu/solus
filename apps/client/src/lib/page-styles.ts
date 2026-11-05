/**
 * The web page's stylesheet does not hold the first paint: the build links it as
 * a preload that becomes a stylesheet when it arrives (`scripts/vite-boot-splash.ts`),
 * and the boot splash shows until then. A surface that mounts before it applies
 * paints with no styles, so every surface waits for `stylesheetsApplied`.
 */

/** The build puts this attribute on each stylesheet link that does not hold the first paint. */
export const DEFERRED_STYLESHEET_ATTRIBUTE = 'data-solus-stylesheet'

/**
 * Settles when each deferred stylesheet of the page applies, or fails to load:
 * a stylesheet that does not come must not keep the splash on the screen. The
 * dev server links no stylesheet in the HTML, so there it settles at once.
 */
export function stylesheetsApplied(page: Pick<Document, 'querySelectorAll'>): Promise<void> {
  const links = [...page.querySelectorAll<HTMLLinkElement>(`link[${DEFERRED_STYLESHEET_ATTRIBUTE}]`)]
  return Promise.all(links.map(stylesheetApplied)).then(() => {})
}

/**
 * The link's own `onload` makes it a stylesheet when the preload arrives; the
 * stylesheet then loads from the cache, and `sheet` is set when it applies.
 * Each `load` is a moment to look again.
 */
function stylesheetApplied(link: HTMLLinkElement): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (link.rel !== 'stylesheet' || !link.sheet) return
      stop()
      resolve()
    }
    const fail = () => {
      stop()
      resolve()
    }
    const stop = () => {
      link.removeEventListener('load', check)
      link.removeEventListener('error', fail)
    }
    link.addEventListener('load', check)
    link.addEventListener('error', fail)
    check()
  })
}
