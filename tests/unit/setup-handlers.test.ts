import { describe, expect, test } from 'bun:test'
import { buildAgentInstallCommand, validateCloneUrl } from '../../src/main/server/handlers/setup-handlers'
import { setupStepIdsForCapabilities } from '../../src/renderer/components/server-setup/lib/setup-steps'
import type { ServerCapabilities } from '../../src/shared/types'

describe('server setup installer command table', () => {
  test('maps agents to fixed official installer argv without client-controlled fragments', () => {
    expect(buildAgentInstallCommand('claude', { hasCommand: () => true })).toEqual({
      command: 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code'],
      display: 'npm install -g @anthropic-ai/claude-code',
      strategy: 'npm',
    })

    expect(buildAgentInstallCommand('codex', { hasCommand: () => true })).toEqual({
      command: 'npm',
      args: ['install', '-g', '@openai/codex'],
      display: 'npm install -g @openai/codex',
      strategy: 'npm',
    })
  })

  test('uses the fixed Claude install-script fallback only when npm is unavailable', () => {
    expect(buildAgentInstallCommand('claude', { hasCommand: () => false })).toEqual({
      command: 'bash',
      args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash -s'],
      display: 'curl -fsSL https://claude.ai/install.sh | bash -s',
      strategy: 'claude-install-script',
    })

    expect(() => buildAgentInstallCommand('codex', { hasCommand: () => false })).toThrow('npm is required')
  })
})

describe('server setup clone URL validation', () => {
  test('accepts well-formed https and ssh git clone URLs', () => {
    expect(validateCloneUrl('https://github.com/solus-sh/solus.git')).toEqual({
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      repoName: 'solus',
    })
    expect(validateCloneUrl('ssh://git@github.com/solus-sh/solus.git')).toEqual({
      cloneUrl: 'ssh://git@github.com/solus-sh/solus.git',
      repoName: 'solus',
    })
    expect(validateCloneUrl('git@github.com:solus-sh/solus.git')).toEqual({
      cloneUrl: 'git@github.com:solus-sh/solus.git',
      repoName: 'solus',
    })
  })

  test('rejects local paths, missing .git suffixes, whitespace, and shell-like suffixes', () => {
    expect(() => validateCloneUrl('file:///tmp/repo.git')).toThrow()
    expect(() => validateCloneUrl('https://github.com/solus-sh/solus')).toThrow()
    expect(() => validateCloneUrl('https://github.com/solus-sh/solus.git --upload-pack=evil')).toThrow()
    expect(() => validateCloneUrl('git@github.com:solus-sh/solus.git;rm -rf /')).toThrow()
  })
})

describe('server setup checklist gap detection', () => {
  test('shows only the setup steps required by current capabilities', () => {
    expect(setupStepIdsForCapabilities(capabilities({
      claudeInstalled: false,
      claudeAuthed: false,
      githubAuthed: false,
      projectCount: 0,
    }))).toEqual(['install-claude', 'claude-auth', 'github', 'project'])

    expect(setupStepIdsForCapabilities(capabilities({
      claudeInstalled: true,
      claudeAuthed: false,
      githubAuthed: true,
      projectCount: 2,
    }))).toEqual(['claude-auth'])

    expect(setupStepIdsForCapabilities(capabilities({
      claudeInstalled: true,
      claudeAuthed: true,
      githubAuthed: true,
      projectCount: 1,
    }))).toEqual([])
  })
})

function capabilities(opts: {
  claudeInstalled: boolean
  claudeAuthed: boolean
  githubAuthed: boolean
  projectCount: number
}): ServerCapabilities {
  return {
    headless: true,
    desktopHandlers: false,
    agents: {
      claude: opts.claudeInstalled,
      codex: true,
    },
    dictation: false,
    platform: 'linux',
    version: '0.0.0',
    projectCount: opts.projectCount,
    agentAuth: {
      claude: opts.claudeAuthed,
    },
    gitAuth: {
      github: opts.githubAuthed,
    },
  }
}
