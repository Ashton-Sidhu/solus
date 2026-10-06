import { readFile, stat } from 'node:fs/promises'
import { SOLUS_THEME_SNAPSHOT, sandboxThemeCss, wrapSandboxDocument } from '@solus/contracts/artifact-sandbox'
import { BROWSER_PARTITION_PREFIX, type BrowserConsoleEntry } from '@solus/contracts/browser-types'
import { inlineLocalImages } from '@solus/contracts/html-local-images'
import { browserHeadlessHost, type BrowserSurfaceDriver } from '../../browser/surface-driver'
import { createLogger } from '../../logger'

const log = createLogger('folio', 'artifact-preview.ts')

/**
 * A still of an `artifact` work, for the places that cannot run it.
 *
 * An external ticket cannot host a sandboxed iframe, so what it gets is a
 * picture of the artifact at a desktop viewport. The picture is taken by the
 * same headless browser an agent drives, through the same driver, so it is
 * the render a user would see and not a second rendering path to maintain.
 *
 * The HTML travels as a data URL rather than being served: the guest needs no
 * origin, and nothing else may ever be able to fetch a work's body by URL.
 */

/** A desktop reading of the artifact — the width the conversation renders it
 *  at, tall enough for one screen of it. What falls below the fold is in the
 *  interactive copy; the still is a preview, not a scroll. */
export const ARTIFACT_PREVIEW_VIEWPORT = {
  width: 960,
  height: 720,
  deviceScaleFactor: 2,
} as const

const SETTLE_TIMEOUT_MS = 4_000

export type ArtifactPreviewAppearance = 'light' | 'dark'

/** PNG data URL of the artifact, or a thrown error naming why this host cannot
 *  take one — a server without the headless browser has no way to draw it. */
export async function renderArtifactPreview(
  html: string,
  appearance: ArtifactPreviewAppearance = 'light',
): Promise<string> {
  const driver = await openPreviewPage(html, appearance, ARTIFACT_PREVIEW_VIEWPORT)
  try {
    await driver.evaluate(settleScript(SETTLE_TIMEOUT_MS))
    return await driver.captureScreenshot()
  } catch (error) {
    log.warn('artifact_preview_failed', { error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    await driver.dispose().catch(() => {})
  }
}

function headlessHost() {
  const host = browserHeadlessHost()
  if (!host) {
    throw new Error(
      'This host cannot render an artifact preview: it has no headless browser. Install playwright-core on the Solus server.',
    )
  }
  return host
}

function openPreviewPage(
  html: string,
  appearance: ArtifactPreviewAppearance,
  viewport: { width: number; height: number; deviceScaleFactor: number },
): Promise<BrowserSurfaceDriver> {
  return headlessHost().open({
    url: `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`,
    // Its own profile, apart from every project's logins. The name keeps the
    // browser profiles' prefix: the Playwright host refuses any other.
    partition: `${BROWSER_PARTITION_PREFIX}-artifact-preview`,
    emulation: {
      viewport: { mode: 'custom', orientation: 'landscape', ...viewport, hasTouch: false },
      appearance,
    },
    report: () => {},
  })
}

/** The reply column at its usual width, where a page in a reply renders. */
export const HTML_PREVIEW_DEFAULT_WIDTH = 760
export const HTML_PREVIEW_MIN_WIDTH = 320
export const HTML_PREVIEW_MAX_WIDTH = 1440
/** The viewport the page is first laid out and measured in. */
const HTML_PREVIEW_MEASURE_HEIGHT = 80
/** A page taller than this is captured to here; the height still reports in full. */
const HTML_PREVIEW_MAX_CAPTURE_HEIGHT = 4_000
const IMAGE_READ_LIMIT_BYTES = 8 * 1024 * 1024

/** What an agent learns from checking a page before it shows it. */
export interface HtmlPreview {
  /** PNG data URL of the whole page, up to the capture limit. */
  screenshot: string
  width: number
  appearance: ArtifactPreviewAppearance
  /** The height the page needs at this width, in CSS pixels. */
  contentHeight: number
  /** What the page logged, uncaught errors and failed loads included. */
  console: BrowserConsoleEntry[]
  /** Local image paths that could not be written into the page. */
  missingImages: string[]
}

/** Uncaught errors and failed resource loads do not reach the console on
 *  their own, so the preview says them there, where the driver records them. */
const ERROR_REPORTER = `<script>(function(){
  addEventListener("error", function(e){
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) console.error("Failed to load " + (t.src || t.href));
    else {
      var message = e.message || "error";
      console.error((/^Uncaught/.test(message) ? "" : "Uncaught ") + message + (e.lineno ? " (line " + e.lineno + ")" : ""));
    }
  }, true);
  addEventListener("unhandledrejection", function(e){
    console.error("Unhandled rejection: " + (e.reason && e.reason.message || e.reason));
  });
})();</script>`

const MEASURE_SCRIPT = `(() => {
  const b = document.body, root = document.documentElement
  if (!b) return JSON.stringify(root ? root.scrollHeight : 0)
  const top = b.getBoundingClientRect().top + (window.scrollY || 0)
  return JSON.stringify(Math.ceil(Math.max(root.getBoundingClientRect().height, top + Math.max(b.scrollHeight, b.offsetHeight))))
})()`

async function readHostImage(path: string): Promise<Blob | null> {
  const info = await stat(path)
  if (!info.isFile() || info.size > IMAGE_READ_LIMIT_BYTES) return null
  return new Blob([await readFile(path)])
}

/** The markup with its local images read from this host and written in. */
export function inlineHostImages(html: string) {
  return inlineLocalImages(html, readHostImage)
}

/**
 * Render agent HTML the way the conversation will show it — the sandbox page,
 * the Solus theme, local images written in — and report what the reader would
 * see: a screenshot, the height the page needs, and what it logged. Nothing is
 * saved and nothing is shown to the user.
 */
export async function previewArtifactHtml(input: {
  html: string
  width?: number
  appearance?: ArtifactPreviewAppearance
}): Promise<HtmlPreview> {
  const appearance = input.appearance ?? 'light'
  const width = Math.round(Math.min(HTML_PREVIEW_MAX_WIDTH, Math.max(HTML_PREVIEW_MIN_WIDTH, input.width ?? HTML_PREVIEW_DEFAULT_WIDTH)))
  const inlined = await inlineLocalImages(input.html, readHostImage)
  const themeCss = sandboxThemeCss(appearance === 'dark', (variable) => SOLUS_THEME_SNAPSHOT[appearance][variable])
  const page = wrapSandboxDocument(ERROR_REPORTER + inlined.html, themeCss)
  // The page is laid out in a short viewport first. The sandbox page renders in
  // quirks mode, where the root stretches to the viewport, so a tall first
  // viewport would be measured as the page's own height.
  const driver = await openPreviewPage(page, appearance, { width, height: HTML_PREVIEW_MEASURE_HEIGHT, deviceScaleFactor: 1 })
  try {
    await driver.evaluate(settleScript(SETTLE_TIMEOUT_MS))
    const contentHeight = Number(JSON.parse(await driver.evaluate(MEASURE_SCRIPT))) || 0
    const captureHeight = Math.min(HTML_PREVIEW_MAX_CAPTURE_HEIGHT, Math.max(1, contentHeight))
    // The viewport grows to the page so the screenshot holds all of it.
    await driver.applyEmulation({
      viewport: { mode: 'custom', orientation: 'landscape', width, height: captureHeight, deviceScaleFactor: 1, hasTouch: false },
      appearance,
    })
    await driver.evaluate(settleScript(SETTLE_TIMEOUT_MS))
    return {
      screenshot: await driver.captureScreenshot(),
      width,
      appearance,
      contentHeight,
      console: driver.consoleEntries(),
      missingImages: inlined.missing,
    }
  } catch (error) {
    log.warn('html_preview_failed', { error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    await driver.dispose().catch(() => {})
  }
}

/** Resolves once the document has loaded and painted two frames, so a chart
 *  that draws itself on load is in the picture; a document that never fires
 *  load still resolves after the timeout rather than hanging the capture. */
function settleScript(timeoutMs: number): string {
  return `new Promise((resolve) => {
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve('ok')))
    if (document.readyState === 'complete') done()
    else window.addEventListener('load', done, { once: true })
    setTimeout(() => resolve('timeout'), ${timeoutMs})
  })`
}
