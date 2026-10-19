import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { AgentProfile, AgentProfileIntegrationEntry } from '@solus/contracts/agent-profile'
import type { Integration, IntegrationConnection } from '@solus/contracts/integration-types'
import { agentProfileChangeBetween } from '@solus/client-core/agent-profile-sync'
import {
  agentProfileKeyLabel,
  conflictRows,
  fileRowText,
  integrationEntryOf,
  profileServerStatus,
  sectionsOf,
  skillEntryOf,
} from '@solus/workspace-ui/components/settings/agent-profile/lib/agent-profile-entries'

/**
 * Settings → Agent profile reads the flat document as four sections, and
 * sends only what changed (plans/020 §3).
 */

const file = (provider: 'claude-code' | 'codex', path: string, text: string) => ({
  kind: 'file' as const, provider, path, contentBase64: Buffer.from(text).toString('base64'), hash: createHash('sha256').update(text).digest('hex'),
})

const entries: AgentProfile = {
  'file:claude-code/commands/ship.md': file('claude-code', 'commands/ship.md', 'Ship.'),
  'file:claude-code/agents/reviewer.md': file('claude-code', 'agents/reviewer.md', 'Review.'),
  'file:claude-code/skills/review/SKILL.md': file('claude-code', 'skills/review/SKILL.md', '# Review'),
  'file:claude-code/skills/review/scripts/run.sh': { ...file('claude-code', 'skills/review/scripts/run.sh', 'echo'), executable: true },
  'file:codex/skills/review/SKILL.md': file('codex', 'skills/review/SKILL.md', '# Review'),
  'file:codex/prompts/plan.md': file('codex', 'prompts/plan.md', 'Plan.'),
  'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' },
  'integration:deepwiki': { kind: 'integration', slug: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'none' } },
}

describe('sections', () => {
  test('the entries sort into files per provider, registry skills, hand-written skills by name, and servers', () => {
    const sections = sectionsOf(entries)
    expect(sections.files.map((group) => group.provider)).toEqual(['claude-code', 'codex'])
    expect(sections.files[0].files.map((entry) => entry.path)).toEqual(['agents/reviewer.md', 'commands/ship.md'])
    expect(sections.files[1].files.map((entry) => entry.path)).toEqual(['prompts/plan.md'])
    expect(sections.registrySkills.map((skill) => skill.name)).toEqual(['deploy'])
    // WHY: a hand-written skill is removed as a whole, so its row must know every key it is made of.
    expect(sections.writtenSkills).toEqual([{
      name: 'review',
      providers: ['claude-code', 'codex'],
      keys: ['file:claude-code/skills/review/SKILL.md', 'file:claude-code/skills/review/scripts/run.sh', 'file:codex/skills/review/SKILL.md'],
      fileCount: 3,
    }])
    expect(sections.integrations.map((integration) => integration.slug)).toEqual(['deepwiki'])
  })
})

describe('file rows', () => {
  test('a file reads by its name, with the folder that says what it is and whether it runs', () => {
    expect(fileRowText('agents/reviewer.md', false)).toEqual({ name: 'reviewer.md', detail: 'agents' })
    expect(fileRowText('commands/deploy/run.sh', true)).toEqual({ name: 'run.sh', detail: 'commands/deploy · Executable' })
    expect(fileRowText('settings.json', false)).toEqual({ name: 'settings.json', detail: 'Home folder' })
  })
})

describe('a profile server on one host', () => {
  const planetscale: AgentProfileIntegrationEntry = {
    kind: 'integration', slug: 'planetscale', name: 'PlanetScale', url: 'https://mcp.pscale.dev/mcp/planetscale',
    auth: { kind: 'oauth', discover: 'https://mcp.pscale.dev/.well-known/oauth-protected-resource/mcp/planetscale', registration: 'dynamic' },
  }
  const onHost: Integration = {
    id: 'int-1', organizationId: 'local', ownerKey: 'person', kind: 'mcp', slug: 'planetscale', name: 'PlanetScale',
    url: planetscale.url, auth: planetscale.auth, disabledTools: [], createdBy: null, createdAt: '', updatedAt: '',
  }
  const connection = (status: IntegrationConnection['status'], source: IntegrationConnection['source'] = 'host'): Map<string, IntegrationConnection> =>
    new Map([['int-1', { integrationId: 'int-1', status, source, label: null, info: null, error: null, updatedAt: '' }]])

  test('a server the profile put on the host, with no sign-in there, has no tools and offers Connect', () => {
    // The cloud session that had no PlanetScale tools: the record synced, the sign-in did not.
    expect(profileServerStatus(planetscale, [onHost], new Map())).toEqual({ text: 'Not connected', tone: 'attention', integrationId: 'int-1', canConnect: true })
  })

  test('a sign-in on the host or in the account reads as connected, with nothing to do', () => {
    expect(profileServerStatus(planetscale, [onHost], connection('connected'))).toMatchObject({ text: 'Connected', tone: 'ready', canConnect: false })
    expect(profileServerStatus(planetscale, [onHost], connection('connected', 'cloud'))).toMatchObject({ text: 'Connected in your Solus account', tone: 'ready' })
  })

  test('an expired sign-in asks to reconnect', () => {
    expect(profileServerStatus(planetscale, [onHost], connection('needs-sign-in'))).toMatchObject({ text: 'Needs sign-in', tone: 'error', canConnect: true })
  })

  test('the host matches its record by address, not by name', () => {
    const renamed = { ...onHost, name: 'Our database', slug: 'db' }
    expect(profileServerStatus(planetscale, [renamed], connection('connected')).integrationId).toBe('int-1')
  })

  test('a server the host does not have yet: Connect adds it only when it needs a sign-in', () => {
    expect(profileServerStatus(planetscale, [], new Map())).toEqual({ text: 'Not added yet', tone: 'attention', integrationId: null, canConnect: true })
    const open = { ...planetscale, auth: { kind: 'none' as const } }
    expect(profileServerStatus(open, [], new Map()).canConnect).toBe(false)
  })

  test('before the host answers, the row does not guess', () => {
    expect(profileServerStatus(planetscale, null, new Map())).toMatchObject({ tone: 'unknown', canConnect: false })
  })
})

describe('new entries', () => {
  test('a skills.sh result becomes a registry reference: the repo is its source, the id after @ its skill id', () => {
    expect(skillEntryOf({ id: 'acme/skills@deploy', name: 'deploy', repo: 'acme/skills', url: 'https://skills.sh/acme/skills/deploy' }))
      .toEqual({ kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' })
    expect(skillEntryOf({ id: 'acme/skills', name: 'skills', repo: 'acme/skills', url: 'https://skills.sh/acme/skills' })).toBeNull()
  })

  test('a probed server becomes a record with a slug from its name and never a credential', () => {
    expect(integrationEntryOf('Deep Wiki!', 'https://mcp.deepwiki.com/mcp', { kind: 'bearer', scheme: 'bearer' }))
      .toEqual({ kind: 'integration', slug: 'deep-wiki', name: 'Deep Wiki!', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'bearer', scheme: 'bearer' } })
  })
})

describe('changes', () => {
  test('a replaced document sets only the entries that differ and resets the keys that left', () => {
    const desired: AgentProfile = {
      'file:claude-code/commands/ship.md': file('claude-code', 'commands/ship.md', 'Ship.'),
      'file:codex/prompts/review.md': file('codex', 'prompts/review.md', 'Review first.'),
      'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' },
    }
    const change = agentProfileChangeBetween(entries, desired)
    expect(Object.keys(change.set)).toEqual(['file:codex/prompts/review.md'])
    expect(change.reset.sort()).toEqual([
      'file:claude-code/agents/reviewer.md',
      'file:claude-code/skills/review/SKILL.md',
      'file:claude-code/skills/review/scripts/run.sh',
      'file:codex/prompts/plan.md',
      'file:codex/skills/review/SKILL.md',
      'integration:deepwiki',
    ])
  })

  test('a conflict row names the entry and says what each side holds', () => {
    expect(agentProfileKeyLabel('file:claude-code/agents/reviewer.md')).toBe('agents/reviewer.md (Claude Code)')
    expect(agentProfileKeyLabel('skill:deploy')).toBe('Skill deploy')
    expect(agentProfileKeyLabel('integration:deepwiki')).toBe('MCP server deepwiki')
    const [row] = conflictRows([{ key: 'integration:deepwiki', mine: {}, theirs: { 'integration:deepwiki': entries['integration:deepwiki'] } }])
    expect(row).toEqual({ key: 'integration:deepwiki', label: 'MCP server deepwiki', mine: 'Removed', theirs: 'https://mcp.deepwiki.com/mcp' })
  })
})

describe('retired entries', () => {
  test('a stored copy and a remote change drop a home\'s AGENTS.md or CLAUDE.md, and keep the rest', async () => {
    // WHY: instruction files left the profile; a copy kept from before must not list them again on any client.
    const { readStoredEntries, writeStoredEntries, applyChange } = await import('@solus/workspace-ui/contexts/seats/lib/agent-profile-local')
    const items = new Map<string, string>()
    const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) } as Storage
    writeStoredEntries(storage, 'anonymous', {
      'file:codex/AGENTS.md': file('codex', 'AGENTS.md', 'old'),
      'file:codex/prompts/plan.md': file('codex', 'prompts/plan.md', 'Plan.'),
    })
    expect(Object.keys(readStoredEntries(storage, 'anonymous') ?? {})).toEqual(['file:codex/prompts/plan.md'])

    const local: AgentProfile = {}
    const applied = applyChange(local, { set: { 'file:claude-code/CLAUDE.md': file('claude-code', 'CLAUDE.md', 'old'), 'file:codex/prompts/plan.md': file('codex', 'prompts/plan.md', 'Plan.') }, reset: [] })
    expect(Object.keys(local)).toEqual(['file:codex/prompts/plan.md'])
    expect(Object.keys(applied.set)).toEqual(['file:codex/prompts/plan.md'])
  })
})
