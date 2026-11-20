import { expect, test, mock } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'

// Bun has no node:sqlite; this code reaches the database through the host's installation id (admission/auth.ts).
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { tailscaleInstallPaths } = await import('@solus/server/transport/endpoints')

test('Windows looks for tailscale.exe under Program Files', () => {
  // WHY: Tailscale for Windows installs its CLI in Program Files, and none of
  // the POSIX folders exist there, so a Windows host never found its tailnet.
  expect(tailscaleInstallPaths('win32', { ProgramFiles: 'D:\\Apps' })).toEqual(['D:\\Apps\\Tailscale\\tailscale.exe'])
  expect(tailscaleInstallPaths('win32', {})).toEqual(['C:\\Program Files\\Tailscale\\tailscale.exe'])
})

test('macOS and Linux keep the POSIX install folders', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    expect(tailscaleInstallPaths(platform, { ProgramFiles: 'C:\\Program Files' })).toEqual([
      '/usr/local/bin/tailscale',
      '/usr/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
    ])
  }
})
