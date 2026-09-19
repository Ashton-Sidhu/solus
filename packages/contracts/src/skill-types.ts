/** Global skills reported by the skills CLI on the selected host. */
export interface InstalledSkill {
  name: string
  path: string
  agents: string[]
  source: string | null
}

export type SkillListResult = { ok: true; skills: InstalledSkill[] } | { ok: false; error: string }
export type SkillRemoveResult = { ok: true } | { ok: false; error: string }
