import { browserHeadlessHost } from '../browser/surface-driver'
import { createLogger } from '../logger'

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
  const host = browserHeadlessHost()
  if (!host) {
    throw new Error(
      'This host cannot render an artifact preview: it has no headless browser. Install playwright-core on the Solus server.',
    )
  }
  const driver = await host.open({
    url: `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`,
    partition: 'artifact-preview',
    emulation: {
      viewport: { mode: 'custom', orientation: 'landscape', ...ARTIFACT_PREVIEW_VIEWPORT, hasTouch: false },
      appearance,
    },
    report: () => {},
  })
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
