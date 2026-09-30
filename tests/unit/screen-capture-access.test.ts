import { describe, expect, mock, test } from 'bun:test'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {},
  shell: {},
  utilityProcess: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
}))
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { registerFileHandlers } = await import('@solus/desktop-main/server/handlers/file-handlers')

/**
 * macOS applies Screen Recording only after the app asks and then reopens.
 * Until then a capture returns an empty desktop, so without access a capture
 * must not run and must not hide or blank the window the user is looking at.
 * Each capture changes the window first, so those calls throw here: a capture
 * that ignores the answer fails before it reaches `screencapture`.
 */
describe('screen capture without Screen Recording access', () => {
  const handlers = new Map<string, () => Promise<unknown>>()
  let accessChecks = 0
  const touchWindow = () => { throw new Error('the capture changed the window without access') }

  registerFileHandlers(
    { register: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) } as never,
    {
      getWorkspaceWindow: () => ({ hide: touchWindow }) as never,
      hideAppWindow: () => {},
      showAndFocusWorkspaceWindow: () => {},
      setWorkspaceWindowOpacity: touchWindow,
      expandDesignModeWindow: touchWindow,
      restoreDesignModeWindow: () => {},
      exitDesignModeWindow: () => {},
      bumpScreenshotCounter: () => 1,
      bumpDesignModeCounter: () => 1,
      bumpPasteCounter: () => 1,
      designModeCaptureRegion: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      ensureScreenCaptureAccess: async () => {
        accessChecks++
        return false
      },
    },
  )

  test.each(['takeScreenshot', 'enterDesignMode'])('%s returns nothing', async (method) => {
    const checksBefore = accessChecks

    expect(await handlers.get(method)!()).toBeNull()
    expect(accessChecks).toBe(checksBefore + 1)
  })
})
