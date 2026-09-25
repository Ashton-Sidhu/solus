import { BrowserWindow } from 'electron'
import { createLogger } from '@solus/server/logger'
import { openScriptEncoder } from '@solus/server/browser/recording-encoder-script'
import {
  setBrowserRecordingEncoderHost,
  type BrowserRecordingEncoder,
  type BrowserRecordingSize,
} from '@solus/server/browser/surface-driver'

const log = createLogger('browser', 'recording-encoder-window.ts')

/**
 * The desktop recording encoder: a blank window that is never shown.
 *
 * Electron is already a Chromium, so the encoder is one more hidden window, like
 * the headless host, instead of a second browser. `backgroundThrottling: false`
 * keeps the canvas stream running in a window nobody sees. It has no preload and
 * an in-memory partition: nothing but the encoder script runs there.
 */
export function registerBrowserRecordingEncoderHost(): void {
  setBrowserRecordingEncoderHost({ open: openEncoderWindow })
}

async function openEncoderWindow(size: BrowserRecordingSize): Promise<BrowserRecordingEncoder> {
  const window = new BrowserWindow({
    show: false,
    width: size.width,
    height: size.height,
    webPreferences: {
      partition: 'solus-recording-encoder',
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const contents = window.webContents
  try {
    await contents.loadURL('about:blank')
    const encoder = await openScriptEncoder(
      (expression) => contents.executeJavaScript(expression),
      size,
      async () => {
        if (!window.isDestroyed()) window.destroy()
      },
    )
    log.info('browser_recording_encoder_opened', { width: size.width, height: size.height })
    return encoder
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}
