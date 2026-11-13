import { z } from 'zod'
import { SOLUS_THEME_SNAPSHOT, sandboxThemeCss, wrapSandboxDocument } from '@solus/contracts/artifact-sandbox'

/**
 * The page an artifact runs in on this client: the shared sandbox document
 * (`@solus/contracts/artifact-sandbox`), as the desktop and web frame run it.
 *
 * A web view has no `parent` frame. The page's height reporter and theme
 * listener talk to their own window, so a bridge script passes height reports
 * on to the app, and the app posts theme updates into the window.
 */

export type ArtifactAppearance = 'light' | 'dark'

const HEIGHT_MESSAGE = 'solus-artifact-height'

const HEIGHT_BRIDGE = `<script>window.addEventListener("message",function(e){var d=e.data;if(d&&d.type===${JSON.stringify(HEIGHT_MESSAGE)}&&typeof d.h==="number"&&window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(HEIGHT_MESSAGE)},h:d.h}));});</script>`

/**
 * The Solus theme for a page, on the feed's own canvas so the page has no
 * visible edge. The client has no workspace stylesheet to read, so the values
 * are the snapshot the host's headless preview uses. A page in the feed grows
 * to its content and never scrolls; a full-screen page scrolls.
 */
export function artifactThemeCss(appearance: ArtifactAppearance, canvas: string, scrollable: boolean): string {
  const values = SOLUS_THEME_SNAPSHOT[appearance]
  const css = sandboxThemeCss(appearance === 'dark', (variable) => (variable === '--solus-container-bg' ? canvas : values[variable]))
  return scrollable ? `${css}html{overflow:auto}` : css
}

// Without it WebKit lays the page out 980px wide and scales it down, so the
// page reports its height in larger pixels than the frame it sits in, and the
// frame grows on every report.
const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1">'

export function artifactDocument(html: string, themeCss: string): string {
  return VIEWPORT + wrapSandboxDocument(HEIGHT_BRIDGE + html, themeCss)
}

/** Script that replaces the page's theme without a reload. */
export function artifactThemeScript(themeCss: string): string {
  return `window.postMessage(${JSON.stringify({ type: 'solus-artifact-theme', css: themeCss })},"*");true;`
}

// Zero means the page has no layout yet, not that it is empty.
const heightMessage = z.object({ type: z.literal(HEIGHT_MESSAGE), h: z.number().positive() })

/** The content height a page reported, or null for any other message. */
export function readArtifactHeight(data: string): number | null {
  try {
    const message = heightMessage.safeParse(JSON.parse(data))
    return message.success ? Math.max(40, Math.ceil(message.data.h)) : null
  } catch {
    return null
  }
}

/** Only the page itself loads in the frame; a link leaves for the browser. */
export function isArtifactDocumentUrl(url: string): boolean {
  return url.startsWith('about:') || url.startsWith('data:')
}

export function isExternalLink(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
