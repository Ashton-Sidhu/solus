/** Global skills reported by the skills CLI on the selected host, or in the caller's seats there. */
export interface InstalledSkill {
  name: string
  path: string
  agents: string[]
  source: string | null
}

/**
 * `host`: the host's own global skills, for every agent on it. `member`: an
 * organization member's own skills on a shared host, in their seats.
 * Absent from an older host, which only has `host`.
 */
export type SkillScope = 'host' | 'member'

export type SkillListResult = { ok: true; skills: InstalledSkill[]; scope?: SkillScope } | { ok: false; error: string }
export type SkillRemoveResult = { ok: true } | { ok: false; error: string }
