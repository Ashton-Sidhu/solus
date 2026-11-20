import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSoftware } from '@solus/server/updates/agent-software'
import { ClaudeSoftwareAdapter } from '@solus/server/updates/claude-software-adapter'
import { CodexSoftwareAdapter } from '@solus/server/updates/codex-software-adapter'
import { agentExecutables, findOnPath, startableCommand } from '@solus/server/cli-env'

let sandbox: string
const previous = process.env.SOLUS_DATA_DIR
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'solus-agent-ownership-'))
  process.env.SOLUS_DATA_DIR = sandbox
})
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
})

function selected(enabled = true) {
  const root = join(sandbox, 'agents', 'codex')
  const binary = join(root, 'releases', 'verified', 'bin', 'codex')
  mkdirSync(join(root, 'releases', 'verified', 'bin'), { recursive: true })
  writeFileSync(binary, 'verified binary')
  chmodSync(binary, 0o755)
  writeFileSync(join(root, 'current.json'), JSON.stringify({ release: 'verified', binary: 'bin/codex', version: '0.170.0', enabled }))
  return { root, binary }
}

test('an absent agent can be installed natively without npm', () => {
  expect(installation('codex', null)).toMatchObject({ method: 'absent', canUpdate: true, automatic: false })
})

test('an npm install keeps its manager and receives a useful manual command', () => {
  const target = join(sandbox, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, '')
  const binary = join(sandbox, 'codex')
  symlinkSync(target, binary)
  expect(installation('codex', binary)).toMatchObject({ method: 'npm', managed: false, canUpdate: false, automatic: false, remediation: 'Run npm install -g @openai/codex on this host.' })
})

test('Homebrew and unknown binaries are not overwritten by the native updater', () => {
  expect(installation('claude', join(sandbox, 'Caskroom', 'claude-code', 'claude'))).toMatchObject({ method: 'homebrew', canUpdate: false })
  expect(installation('codex', join(sandbox, 'custom', 'codex'))).toMatchObject({ method: 'external', canUpdate: false })
})

test.each([
  ['claude', '@anthropic-ai/claude-code', 'claude-code'],
  ['codex', '@openai/codex', 'codex'],
] as const)('%s detects its own package and gives its own update command', (agent, npmPackage, brewPackage) => {
  const path = join(sandbox, 'node_modules', npmPackage, 'bin', agent)
  expect(installation(agent, path)).toMatchObject({ method: 'npm', remediation: `Run npm install -g ${npmPackage} on this host.` })
  expect(installation(agent, join(sandbox, 'Caskroom', brewPackage, agent))).toMatchObject({ method: 'homebrew', remediation: `Run brew upgrade ${brewPackage} on this host.` })
  const otherAgent = agent === 'claude' ? 'codex' : 'claude'
  expect(installation(otherAgent, path)).toMatchObject({ method: 'external' })
})

test('command discovery and process launch use the selected package', () => {
  const { binary } = selected()
  expect(agentExecutables.codex.binary).toBe(binary)
  expect(findOnPath('codex', sandbox)).toBe(binary)
  expect(startableCommand('codex', { PATH: sandbox })).toEqual({ file: binary, args: [] })
  expect(installation('codex', binary)).toMatchObject({ method: 'native', managed: true, canUpdate: true, automatic: true })
})

test('returning to the existing installation disables the managed selection', () => {
  selected(false)
  const external = join(sandbox, 'codex')
  writeFileSync(external, '')
  chmodSync(external, 0o755)
  expect(agentExecutables.codex.binary).toBeNull()
  expect(findOnPath('codex', sandbox)).toBe(external)
})

test('a selection cannot name a package outside the managed releases directory', () => {
  const { root } = selected()
  writeFileSync(join(root, 'current.json'), JSON.stringify({ release: '../../outside', binary: 'codex', version: '0.170.0' }))
  expect(agentExecutables.codex.selection).toBeNull()
  expect(agentExecutables.codex.binary).toBeNull()
})

function installation(agent: 'claude' | 'codex', path: string | null) {
  const software = new AgentSoftware(agent === 'claude' ? new ClaudeSoftwareAdapter() : new CodexSoftwareAdapter(), {
    automatic: () => true,
    existingBinary: () => path,
  })
  software.refreshInstallation()
  return software.status.installation
}
