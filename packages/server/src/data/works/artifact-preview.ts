import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
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
  /** The part of the address after `#`: the page of an app to open. */
  fragment = '',
): Promise<BrowserSurfaceDriver> {
  return headlessHost().open({
    url: `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}${fragment ? `#${encodeURI(fragment)}` : ''}`,
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

/** The reply column at its usual width, where a page in a reply renders:
 *  the 46rem floor of `--solus-reading-max` in workspace.css. */
export const HTML_PREVIEW_DEFAULT_WIDTH = 736
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

/**
 * What answers an app page's calls while it is previewed (docs/plans/apps.md
 * §7). The page runs under the app policy with these network hosts, and each
 * `solusApp.call` it makes is answered by `call` before the picture is taken.
 */
export interface AppPreviewHost {
  network: readonly string[]
  call(name: string, args: AppPreviewArguments): Promise<AppPreviewValue>
  /** The page of the app to open: what its address has after `#`. */
  route?: string
}

/** An app is a window, not a document: it is previewed in a window of this size, at the width asked for. */
export const APP_PREVIEW_DEFAULT_WIDTH = 1100
export const APP_PREVIEW_HEIGHT = 800

const appPreviewValueSchema = z.json()
export type AppPreviewValue = z.infer<typeof appPreviewValueSchema>
const appPreviewArgumentsSchema = z.record(z.string(), appPreviewValueSchema)
export type AppPreviewArguments = z.infer<typeof appPreviewArgumentsSchema>
const appPreviewCallsSchema = z.array(z.object({ id: z.number(), name: z.string(), args: appPreviewArgumentsSchema.catch({}) }))

/** How long a preview answers an app's calls before it takes the picture anyway. */
const APP_PREVIEW_CALLS_MS = 12_000
const APP_PREVIEW_POLL_MS = 120
/** Polls with no call and none in flight before the page counts as settled. */
const APP_PREVIEW_IDLE_POLLS = 3

// The page's own bridge posts to a parent frame, and a preview page has none.
// This one keeps the calls for the driver to take, since the driver can
// evaluate in the page and the page cannot reach the driver.
const APP_PREVIEW_BRIDGE = `<script>(function(){
  var queue = [], pending = {}, next = 1;
  window.__solusAppPreview = {
    take: function(){ var out = queue; queue = []; return JSON.stringify(out); },
    settle: function(id, ok, value){
      var call = pending[id];
      if (!call) return;
      delete pending[id];
      if (ok) call.resolve(value); else call.reject(new Error(String(value)));
    },
    waiting: function(){ return Object.keys(pending).length; }
  };
  window.solusApp = { call: function(name, args){
    return new Promise(function(resolve, reject){
      var id = next++;
      pending[id] = { resolve: resolve, reject: reject };
      queue.push({ id: id, name: String(name), args: args || {} });
    });
  }, on: function(){ return function(){}; } };
})();</script>`

/** A value the driver evaluated: the guest's JSON text, which may itself hold JSON text. */
function evaluated(text: string): AppPreviewValue {
  const value = appPreviewValueSchema.parse(JSON.parse(text))
  const nested = z.string().safeParse(value)
  return nested.success ? appPreviewValueSchema.parse(JSON.parse(nested.data)) : value
}

/** Answers the page's calls until it makes no more, so the picture shows the app with its data and not its loading state. */
async function answerAppCalls(driver: BrowserSurfaceDriver, app: AppPreviewHost): Promise<void> {
  const deadline = Date.now() + APP_PREVIEW_CALLS_MS
  let idlePolls = 0
  while (Date.now() < deadline && idlePolls < APP_PREVIEW_IDLE_POLLS) {
    const calls = appPreviewCallsSchema.parse(evaluated(await driver.evaluate('window.__solusAppPreview.take()')))
    if (calls.length === 0) {
      idlePolls++
      await driver.evaluate(`new Promise((resolve) => setTimeout(() => resolve('ok'), ${APP_PREVIEW_POLL_MS}))`)
      continue
    }
    idlePolls = 0
    await Promise.all(calls.map(async (call) => {
      const answer = await app.call(call.name, call.args).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, value: error instanceof Error ? error.message : String(error) }),
      )
      await driver.evaluate(`window.__solusAppPreview.settle(${call.id}, ${answer.ok}, ${JSON.stringify(answer.value ?? null)}), 'ok'`)
    }))
  }
}

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
  /** The page is an app: it runs under the app policy, and this answers its calls. */
  app?: AppPreviewHost
}): Promise<HtmlPreview> {
  const appearance = input.appearance ?? 'light'
  const width = Math.round(Math.min(HTML_PREVIEW_MAX_WIDTH, Math.max(HTML_PREVIEW_MIN_WIDTH, input.width ?? (input.app ? APP_PREVIEW_DEFAULT_WIDTH : HTML_PREVIEW_DEFAULT_WIDTH))))
  const inlined = await inlineLocalImages(input.html, readHostImage)
  const themeCss = sandboxThemeCss(appearance === 'dark', (variable) => SOLUS_THEME_SNAPSHOT[appearance][variable])
  const page = input.app
    ? wrapSandboxDocument(ERROR_REPORTER + APP_PREVIEW_BRIDGE + inlined.html, themeCss, false, { network: input.app.network })
    : wrapSandboxDocument(ERROR_REPORTER + inlined.html, themeCss)
  if (input.app) return previewAppWindow(page, input.app, { width, appearance, missingImages: inlined.missing })
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

/**
 * An app as its window shows it: the page of the app the route names, in a
 * window of the preview's size, after its calls were answered. The picture is
 * the window, not the whole page: an app scrolls inside it.
 */
async function previewAppWindow(
  page: string,
  app: AppPreviewHost,
  shown: Pick<HtmlPreview, 'width' | 'appearance' | 'missingImages'>,
): Promise<HtmlPreview> {
  const driver = await openPreviewPage(page, shown.appearance, { width: shown.width, height: APP_PREVIEW_HEIGHT, deviceScaleFactor: 1 }, app.route)
  try {
    await driver.evaluate(settleScript(SETTLE_TIMEOUT_MS))
    await answerAppCalls(driver, app)
    await driver.evaluate(settleScript(SETTLE_TIMEOUT_MS))
    return { ...shown, screenshot: await driver.captureScreenshot(), contentHeight: APP_PREVIEW_HEIGHT, console: driver.consoleEntries() }
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
