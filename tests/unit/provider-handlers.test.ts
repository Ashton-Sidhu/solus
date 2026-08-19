import { describe, expect, test } from 'bun:test'
import { registerProviderHandlers } from '@solus/server/server/handlers/provider-handlers'
import { SolusServer } from '@solus/server/server/server'

describe('provider credential export', () => {
  test('refuses to export the host credential to a paired remote device', async () => {
    // WHY: the desktop renderer is itself a WS-paired device, so without this
    // gate any paired phone or laptop could pull the user's GitHub token off it.
    const server = new SolusServer()
    registerProviderHandlers(server, {
      isWorktreeInUse: () => false,
      dispatcher: {
        runAgent: () => { throw new Error('Unexpected agent dispatch') },
      },
    })

    await expect(server.handle(
      'githubExportCredential',
      [],
      { deviceLabel: "Ash's iPhone", deviceId: 'dev_x' },
    )).rejects.toThrow('Only this device can export its GitHub credential.')
  })
})
