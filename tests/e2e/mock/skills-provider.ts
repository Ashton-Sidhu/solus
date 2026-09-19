import type { AgentId, RemoteSkill, SkillInstallResult } from '@solus/contracts/types'

/**
 * Test-build replacement for src/main/skills/skills-provider.ts (aliased in
 * electron.vite.config.ts when BUILD_TARGET=test).
 *
 * Deterministic fixtures for e2e — the real handlers call networked services,
 * which are non-hermetic. Search does a substring match so an unmatched query
 * still exercises the empty state.
 */
const MOCK_SKILLS: RemoteSkill[] = [
  {
    id: 'mock-org/agent-skills@mock-react-best-practices',
    name: 'mock-react-best-practices',
    repo: 'mock-org/agent-skills',
    installs: '12.3K',
    url: 'https://skills.sh/mock-org/agent-skills/mock-react-best-practices',
  },
  {
    id: 'mock-org/agent-skills@mock-testing',
    name: 'mock-testing',
    repo: 'mock-org/agent-skills',
    installs: '4.5K',
    url: 'https://skills.sh/mock-org/agent-skills/mock-testing',
  },
  {
    id: 'mock-org/other-skills@mock-testing',
    name: 'mock-testing',
    repo: 'mock-org/other-skills',
    installs: '1.2K',
    url: 'https://skills.sh/mock-org/other-skills/mock-testing',
  },
]

export async function searchSkills(query: string): Promise<RemoteSkill[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return MOCK_SKILLS.filter((s) => s.name.includes(q) || s.repo.includes(q))
}

const installedIds = new Set<string>()

export async function installSkill(id: string, agents: AgentId[]): Promise<SkillInstallResult> {
  // Mirror the contract the real CLI enforces: a valid target is `owner/repo@skill`.
  // This makes the e2e fail loudly if the UI ever passes a mangled id.
  const valid = /^[^/\s]+\/[^@\s]+@[^\s]+$/.test(id)
  if (valid) installedIds.add(id)
  return valid
    ? { ok: true, agents }
    : { ok: false, agents, error: `Invalid skill id: ${id}` }
}

export async function listInstalledSkills(): Promise<import('@solus/contracts/skill-types').SkillListResult> {
  return { ok: true, skills: MOCK_SKILLS.filter((skill) => installedIds.has(skill.id)).map((skill) => ({
    name: skill.name, path: `/test/skills/${skill.name}`, source: skill.repo, agents: ['Claude Code', 'Codex'],
  })) }
}

export async function removeSkill(name: string): Promise<import('@solus/contracts/skill-types').SkillRemoveResult> {
  for (const skill of MOCK_SKILLS) {
    if (skill.name === name) installedIds.delete(skill.id)
  }
  return { ok: true }
}
