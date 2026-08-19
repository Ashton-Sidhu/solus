import { describe, expect, test } from 'bun:test'
import { registerCapabilityHandlers } from '@solus/server/server/handlers/capability-handlers'
import { SolusServer } from '@solus/server/server/server'

describe('host capability handler', () => {
  test('advertises registered features and caches editor detection', async () => {
    // WHY: the record describes this host build, not auth state or client
    // locality, and editor detection must not repeat for every client probe.
    const server = new SolusServer()
    let editorProbes = 0
    server.register('attachUpload', () => '/tmp/upload')
    server.register('assetCreateUrl', () => ({ relativeUrl: '/asset', expiresAt: 1 }))
    server.register('skillsSearch', () => [])
    server.register('skillsInstall', () => ({ ok: true }))
    server.register('voiceModelStatus', () => ({ state: 'ready' }))
    server.register('automationList', () => [])
    server.register('providerStatus', () => ({ connected: false }))
    server.register('detectEditors', () => {
      editorProbes++
      return {
        editors: [
          { id: 'vscode', name: 'VS Code', isTerminal: false, binPath: '/bin/code' },
          { id: 'future-editor', name: 'Future', isTerminal: false, binPath: '/bin/future' },
        ],
        terminals: [],
      }
    })
    registerCapabilityHandlers(server)

    const expected = {
      attachUpload: true,
      assetUrls: true,
      skillsInstall: true,
      skillsSearch: true,
      voiceModel: true,
      automations: true,
      editors: ['vscode'],
      githubProvider: true,
    }
    expect(await server.handle('serverGetCapabilities', [])).toEqual(expected)
    expect(await server.handle('serverGetCapabilities', [])).toEqual(expected)
    expect(editorProbes).toBe(1)
  })

  test('omits editor payload and reports false for handlers this host lacks', async () => {
    const server = new SolusServer()
    registerCapabilityHandlers(server)

    expect(await server.handle('serverGetCapabilities', [])).toEqual({
      attachUpload: false,
      assetUrls: false,
      skillsInstall: false,
      skillsSearch: false,
      voiceModel: false,
      automations: false,
      githubProvider: false,
    })
  })
})
