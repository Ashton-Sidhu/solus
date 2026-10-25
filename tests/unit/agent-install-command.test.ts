import { expect, test } from 'bun:test'
import { buildAgentInstallCommand } from '../../packages/server/src/transport/handlers/setup-commands'

test('Claude installs on Windows with the PowerShell installer, not bash', () => {
  // WHY: Windows has no bash and no curl pipe; the bash installer failed before it started.
  const spec = buildAgentInstallCommand('claude', { platform: 'win32' })
  expect(spec.command).toBe('powershell.exe')
  expect(spec.args.at(-1)).toBe('irm https://claude.ai/install.ps1 | iex')
  expect(spec.display).toBe('irm https://claude.ai/install.ps1 | iex')
})

test('Claude installs elsewhere with the bash installer', () => {
  expect(buildAgentInstallCommand('claude', { platform: 'linux' }).command).toBe('bash')
})
