import { app, desktopCapturer, dialog, session, shell, systemPreferences } from 'electron'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createLogger } from '@solus/server/logger'

/**
 * macOS privacy permissions, asked for when a feature first needs them.
 *
 * Solus does not ask at launch. A new user gets one system prompt for the
 * microphone on their first voice recording, and one for Screen Recording on
 * their first screenshot. macOS lists an app in System Settings only after the
 * app has asked, so both paths ask first and send the user to Settings only
 * after that.
 */

const log = createLogger('main', 'mac-permissions')

const MICROPHONE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/** Makes a renderer microphone request ask macOS first. Other permission
 *  requests keep Electron's default, which grants them. */
export function handleMicrophoneRequests(): void {
  if (process.platform !== 'darwin') return
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const wantsAudio = permission === 'media' && 'mediaTypes' in details && details.mediaTypes?.includes('audio')
    if (!wantsAudio) {
      callback(true)
      return
    }
    microphoneAccess().then(callback, (err: Error) => {
      log.warn('microphone_permission_check_failed', { error: err.message })
      callback(false)
    })
  })
}

async function microphoneAccess(): Promise<boolean> {
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone')
  await offerSettings({
    message: 'Turn on Microphone access for Solus.',
    detail: 'Voice input needs the microphone. In System Settings, turn on Solus under Privacy & Security > Microphone.',
    url: MICROPHONE_SETTINGS_URL,
  })
  return false
}

/**
 * Whether Solus can capture the screen now.
 *
 * macOS reports Screen Recording only as granted or not, so a flag file records
 * that Solus has asked once. The first call asks through `desktopCapturer`,
 * which shows the system prompt and adds Solus to the Settings list. A later
 * call without access opens that list. macOS applies a new grant only after the
 * app reopens.
 */
export async function ensureScreenCaptureAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true

  const askedFlag = join(app.getPath('userData'), 'screen-recording-requested')
  if (!existsSync(askedFlag)) {
    writeFileSync(askedFlag, '')
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    } catch (err) {
      log.warn('screen_permission_request_failed', { error: err instanceof Error ? err.message : String(err) })
    }
    return false
  }

  await offerSettings({
    message: 'Turn on Screen Recording for Solus.',
    detail: 'Screenshots and design mode need Screen Recording. In System Settings, turn on Solus under Privacy & Security > Screen & System Audio Recording, then quit and reopen Solus.',
    url: SCREEN_RECORDING_SETTINGS_URL,
  })
  return false
}

async function offerSettings(prompt: { message: string; detail: string; url: string }): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: prompt.message,
    detail: prompt.detail,
    buttons: ['Open System Settings', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) await shell.openExternal(prompt.url)
}
