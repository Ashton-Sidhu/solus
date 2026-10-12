import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { AgentProfile } from '@solus/contracts/agent-profile'
import { agentProfileChangeBetween } from '@solus/client-core/agent-profile-sync'
import {
  agentProfileKeyLabel,
  conflictRows,
  decodeFileText,
  encodeFileEntry,
  integrationEntryOf,
  sectionsOf,
  skillEntryOf,
} from '@solus/workspace-ui/components/settings/agent-profile/lib/agent-profile-entries'

/**
 * Settings → Agent profile reads the flat document as four sections, edits an
 * instruction file as text, and sends only what changed (plans/020 §3). A file
 * it encodes must hash as the host does, or a host would see every saved
 * instruction file as a change from its own copy.
 */

const file = (provider: 'claude-code' | 'codex', path: string, text: string) => ({
  kind: 'file' as const, provider, path, contentBase64: Buffer.from(text).toString('base64'), hash: createHash('sha256').update(text).digest('hex'),
})

const entries: AgentProfile = {
  'file:claude-code/CLAUDE.md': file('claude-code', 'CLAUDE.md', 'Be brief.'),
  'file:claude-code/agents/reviewer.md': file('claude-code', 'agents/reviewer.md', 'Review.'),
  'file:claude-code/skills/review/SKILL.md': file('claude-code', 'skills/review/SKILL.md', '# Review'),
  'file:claude-code/skills/review/scripts/run.sh': { ...file('claude-code', 'skills/review/scripts/run.sh', 'echo'), executable: true },
  'file:codex/skills/review/SKILL.md': file('codex', 'skills/review/SKILL.md', '# Review'),
  'file:codex/prompts/plan.md': file('codex', 'prompts/plan.md', 'Plan.'),
  'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' },
  'integration:deepwiki': { kind: 'integration', slug: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'none' } },
}

describe('sections', () => {
  test('the entries sort into instructions per provider, registry skills, hand-written skills by name, and servers', () => {
    const sections = sectionsOf(entries)
    expect(sections.instructions.map((group) => group.provider)).toEqual(['claude-code', 'codex'])
    expect(sections.instructions[0].instructions?.path).toBe('CLAUDE.md')
    expect(sections.instructions[0].otherFiles.map((entry) => entry.path)).toEqual(['agents/reviewer.md'])
    // Codex has no AGENTS.md here, so its group offers an empty editor rather than disappearing.
    expect(sections.instructions[1].instructions).toBeNull()
    expect(sections.instructions[1].otherFiles.map((entry) => entry.path)).toEqual(['prompts/plan.md'])
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

describe('instruction files', () => {
  test('an edit encodes to a file entry whose hash is the host\'s SHA-256 of the content', async () => {
    const text = 'Be brief.\n\nPrefer tests over prose. Ünïcödé too.'
    const entry = await encodeFileEntry('codex', 'AGENTS.md', text)
    expect(entry).toEqual({
      kind: 'file', provider: 'codex', path: 'AGENTS.md',
      contentBase64: Buffer.from(text, 'utf8').toString('base64'),
      hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    })
    expect(decodeFileText(entry)).toBe(text)
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
      'file:claude-code/CLAUDE.md': file('claude-code', 'CLAUDE.md', 'Be brief.'),
      'file:codex/AGENTS.md': file('codex', 'AGENTS.md', 'Plan first.'),
      'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' },
    }
    const change = agentProfileChangeBetween(entries, desired)
    expect(Object.keys(change.set)).toEqual(['file:codex/AGENTS.md'])
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
    expect(agentProfileKeyLabel('file:claude-code/CLAUDE.md')).toBe('CLAUDE.md (Claude Code)')
    expect(agentProfileKeyLabel('skill:deploy')).toBe('Skill deploy')
    expect(agentProfileKeyLabel('integration:deepwiki')).toBe('MCP server deepwiki')
    const [row] = conflictRows([{ key: 'integration:deepwiki', mine: {}, theirs: { 'integration:deepwiki': entries['integration:deepwiki'] } }])
    expect(row).toEqual({ key: 'integration:deepwiki', label: 'MCP server deepwiki', mine: 'Removed', theirs: 'https://mcp.deepwiki.com/mcp' })
  })
})
