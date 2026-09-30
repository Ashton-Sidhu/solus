import { createLogger } from '../logger'
import { openScriptEncoder, type EncoderPageValue } from './recording-encoder-script'
import { setBrowserRecordingEncoderHost, type BrowserRecordingEncoderHost } from './surface-driver'

/**
 * The recording encoder on a standalone server: one Playwright Chromium.
 *
 * Separate from the browser that hosts pages, because that one is a set of
 * persistent profiles with the user's logins in them, and an encoder page has no
 * business there. It starts with the first recording and closes with the last,
 * so a server that never records never pays for a second browser.
 */

const log = createLogger('browser', 'recording-encoder-playwright.ts')

/** The Playwright surface this file uses. Declared, not imported: the package
 *  is optional (see `playwright-host.ts`). */
interface EncoderPage {
  evaluate(expression: string): Promise<EncoderPageValue>
  close(): Promise<void>
}

interface EncoderBrowser {
  newPage(): Promise<EncoderPage>
  close(): Promise<void>
}

export interface EncoderChromium {
  launch(options: { headless: boolean; args: string[] }): Promise<EncoderBrowser>
}

/** Register the encoder when this host has Playwright. Returns the disposer, or
 *  null when there is nothing to register. */
export async function registerPlaywrightRecordingEncoderHost(
  chromium: EncoderChromium | null = null,
): Promise<(() => Promise<void>) | null> {
  const loaded = chromium ?? await loadChromium()
  if (!loaded) return null
  const pool = playwrightEncoderPool(loaded)
  setBrowserRecordingEncoderHost({ open: pool.open })
  return async () => {
    setBrowserRecordingEncoderHost(null)
    await pool.close()
  }
}

export interface PlaywrightEncoderPool extends BrowserRecordingEncoderHost {
  /** Close the browser, whatever is still open on it. */
  close(): Promise<void>
}

/** One browser, one blank page per recording, reference-counted. */
export function playwrightEncoderPool(chromium: EncoderChromium): PlaywrightEncoderPool {
  let current: { browser: Promise<EncoderBrowser>; users: number } | null = null

  return {
    async open(size) {
      current ??= {
        browser: chromium.launch({
          headless: true,
          args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
        }),
        users: 0,
      }
      const pool = current
      pool.users += 1
      const release = async (): Promise<void> => {
        pool.users -= 1
        if (pool.users > 0 || current !== pool) return
        current = null
        await pool.browser.then((instance) => instance.close()).catch(() => {})
        log.info('browser_recording_encoder_closed', {})
      }
      let page: EncoderPage | null = null
      try {
        const opened = await (await pool.browser).newPage()
        page = opened
        return await openScriptEncoder(
          (expression) => opened.evaluate(expression),
          size,
          async () => {
            await opened.close().catch(() => {})
            await release()
          },
        )
      } catch (error) {
        // A launch that failed is forgotten with the last release, so the next
        // recording tries again.
        await page?.close().catch(() => {})
        await release()
        throw error
      }
    },
    async close() {
      const closing = current
      current = null
      await closing?.browser.then((instance) => instance.close()).catch(() => {})
    },
  }
}

async function loadChromium(): Promise<EncoderChromium | null> {
  const specifier = ['playwright', 'core'].join('-')
  try {
    const loaded: { chromium?: EncoderChromium } = await import(specifier)
    return loaded.chromium ?? null
  } catch {
    return null
  }
}
